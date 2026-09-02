// S1 (#36): CORE. An ExternalPrincipal becomes a local user here and nowhere
// else — domain policy, linking and role assignment in one place, so S2 (SAML)
// and S3 (LDAP) inherit one policy instead of three implementations that drift.
//
// Drivers authenticate and normalize; they never reach this far (seam 01
// §Boundaries). S13 (MFA) wraps this function rather than forking the flow.

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const prismaDefault = require("../prisma");
const { syncLegacyRoleGrant } = require("../authorization/legacyRoleGrants");
const {
  deriveUsername,
  usernameCandidates,
  normalizeForCompare,
} = require("./deriveUsername");
const {
  IdentityConflictError,
  IdentityAuthenticationError,
  IdentityUnavailableError,
} = require("../identityProviders/errors");

// R2 (PMO ruling): a first-time SSO user is a plain member. Group→role mapping
// is S4's job — "the IdP said they are an admin" is exactly the claim a driver
// must not be trusted with, and doing it here would mean two implementations.
const DEFAULT_ROLE = "default";

// Username derivation lives in its own module so every driver derives the same
// way. QA-1 NIT-1: the previous version here deleted leading characters that
// were not a-z, so `alice@`, `1alice@` and `_alice@` all became one username.

/**
 * Fill the password column with a value nobody holds.
 *
 * The column is NOT NULL and the local login path bcrypt-compares against it,
 * so it cannot be blank — a short or empty hash is a password-less login. This
 * hashes 64 random bytes that are then discarded: no one can present the
 * plaintext, and the account is reachable only through SSO or a deliberate
 * admin-driven reset.
 */
function unusablePassword() {
  return bcrypt.hashSync(crypto.randomBytes(64).toString("base64url"), 10);
}

/**
 * Resolve an external identity to a local user.
 *
 * @param {{provider:string, subject:string, email:string, emailVerified:boolean,
 *          displayName:string|null, groups:string[], claims:Object}} principal
 * @param {{db?:Object}} options
 * @returns {Promise<{user:Object, created:boolean}>}
 */
async function linkPrincipal(principal, { db = prismaDefault } = {}) {
  const { provider, subject, email, emailVerified } = principal ?? {};
  if (!provider || !subject || !email)
    throw new IdentityAuthenticationError("The identity assertion was incomplete.");

  // Belt and braces: the driver already refuses these, but core owns domain
  // policy and must not depend on a driver having done its job.
  if (emailVerified !== true)
    throw new IdentityAuthenticationError(
      "The identity provider did not verify this email address."
    );

  // The same normalization the handle comparison uses, so the two sides cannot
  // drift apart: `User+X@` and `user+x@` are one mailbox, in both checks.
  const normalizedEmail = normalizeForCompare(email);

  const existingLink = await db.identity_links.findUnique({
    where: { provider_subject: { provider, subject } },
    include: { user: true },
  });

  if (existingLink) {
    // Suspension is an admin's decision. An ingress that ignored it would make
    // suspending an account meaningless — they would simply log in over here.
    if (existingLink.user.suspended)
      throw new IdentityAuthenticationError("This account is suspended.");

    // Identity is provider+subject, so a changed email updates the link and
    // keeps the account. The reverse — same email, new subject — is handled
    // below and is a refusal.
    await db.identity_links.update({
      where: { provider_subject: { provider, subject } },
      data: { email: normalizedEmail, lastLoginAt: new Date() },
    });
    return { user: existingLink.user, created: false };
  }

  // R1 (PMO ruling): a new external identity whose email matches an existing
  // account is REFUSED, never auto-linked. Auto-linking is the classic
  // takeover — anyone who can register that address at the IdP inherits the
  // account. Deliberate linking happens from settings, while already logged in.
  //
  // The checks below run in a FIXED order, and the order is itself the ruling:
  //
  //   1. email match  — the address itself is already known here
  //   2. handle match — the address is new, but derives onto someone's handle
  //
  // The other way round, the handle rule would SHADOW the email rule: an
  // account linked to a DIFFERENT provider under the same address would look
  // like "someone else who happens to share a handle" and fall through to the
  // suffix retry, quietly creating a second account for one mailbox. Email
  // match wins first, and it does not care whether the account it hits is a
  // local one or already federated elsewhere.

  // (1a) The address is already federated, under this provider or another.
  const emailAlreadyLinked = await db.identity_links.findFirst({
    where: { email: normalizedEmail },
  });
  if (emailAlreadyLinked)
    throw new IdentityConflictError(
      "This email is already linked to another identity. Sign in with the " +
        "original provider and manage links from your settings."
    );

  // (1b) A local account stored under the raw address.
  const byEmail = await db.users.findFirst({
    where: { username: { equals: normalizedEmail, mode: "insensitive" } },
  });
  if (byEmail)
    throw new IdentityConflictError(
      "An account with this email already exists. Sign in with your existing " +
        "credentials and link this identity provider from your settings."
    );

  // (2) The address is new here, but the handle it derives to is taken.
  //
  // An account is stored under its username, which for an SSO-created account
  // is the derived form — so comparing only the raw address misses this and
  // lets it fall through to a P2002 the caller sees as a bare 401, against the
  // FIRST person's account, which did nothing wrong.
  //
  // PMO ruling: a derived-handle match is a takeover only when the account it
  // hits is LOCAL. Two different mailboxes can sanitize to one handle (`user+x@`
  // and `user!x@` both give `user-x@`), and telling those people "an account
  // with this email already exists" would be false — no account with their
  // email exists and they are taking nothing over. Those fall through to the
  // suffix retry below and get their own account.
  //
  // Both sides go through the same normalization deriveUsername uses (NFC then
  // lowercase); comparing on anything else means `User+X@` and `user+x@` are
  // two handles for one mailbox and the rule silently stops firing.
  const derivedUsername = deriveUsername(normalizedEmail);
  const handleCollision = await db.users.findFirst({
    where: { username: { equals: derivedUsername, mode: "insensitive" } },
    include: { identity_links: true },
  });
  if (handleCollision && handleCollision.identity_links.length === 0)
    throw new IdentityConflictError(
      "An account with this email already exists. Sign in with your existing " +
        "credentials and link this identity provider from your settings."
    );

  // QA-1 NIT-1: two different mailboxes can legitimately derive the same
  // handle. Retrying with a suffix turns that into a second account, where
  // before it surfaced as a unique-constraint error the caller saw as a bare
  // 401 — against the FIRST person's account, which had done nothing wrong.
  //
  // This is not the R1 takeover case: that is decided on the email, above, and
  // has already refused by the time we get here.
  let user = null;
  let lastError = null;
  for (const username of usernameCandidates(normalizedEmail)) {
    try {
      user = await db.users.create({
        data: {
          username,
          password: unusablePassword(),
          role: DEFAULT_ROLE,
        },
      });
      break;
    } catch (error) {
      // Only a username collision is worth another attempt. Anything else —
      // a dead connection, a constraint we did not anticipate — must surface.
      if (error?.code !== "P2002") throw error;
      lastError = error;
    }
  }
  // Techlead NIT-2: exhausting five random suffixes is not a conflict. A
  // conflict says "this identity belongs to someone else, an admin must sort it
  // out"; five 4-byte collisions in a row says the database is not behaving, and
  // the same login will very likely succeed on the next attempt. Only
  // IdentityUnavailableError is retryable, which is what this actually is.
  if (!user)
    throw new IdentityUnavailableError(
      "Could not create an account for this identity. Please try again.",
      { cause: lastError }
    );

  // T-4a: a user with no grant is DENIED by the authorization engine, so a
  // login that skipped this would succeed into an account that can do nothing.
  await syncLegacyRoleGrant(user, { db });

  await db.identity_links.create({
    data: {
      userId: user.id,
      provider,
      subject,
      email: normalizedEmail,
      lastLoginAt: new Date(),
    },
  });

  return { user, created: true };
}

// `usernameFromEmail` is re-exported under its new name so callers and tests
// have one place to import from; the derivation itself lives in deriveUsername.
module.exports = { linkPrincipal, deriveUsername, usernameCandidates };
