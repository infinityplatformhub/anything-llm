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
const { deriveUsername, usernameCandidates } = require("./deriveUsername");
const {
  IdentityConflictError,
  IdentityAuthenticationError,
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

  const normalizedEmail = String(email).toLowerCase();

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
  // local account is REFUSED, never auto-linked. Auto-linking is the classic
  // takeover — anyone who can register that address at the IdP inherits the
  // account. Deliberate linking happens from settings, while already logged in.
  // Checked against BOTH the raw address and the username it would derive to.
  // A local account is stored under its username, which for an SSO-created
  // account is the derived form — so comparing only the raw address misses the
  // collision and lets it fall through to a P2002 the caller sees as a bare
  // 401. Techlead: this must reach the user as R1's 409, which is the answer
  // that tells them what to do.
  // Checked against BOTH the raw address and the username it would derive to.
  // A local account created by an admin is stored under whatever username they
  // chose, which may be the derived form — comparing only the raw address
  // misses that and lets it fall through to a P2002 the caller sees as a bare
  // 401, against the FIRST person's account.
  //
  // But the derived-username match is only a takeover when the account it hits
  // is a LOCAL one. Two different mailboxes can sanitize to the same handle
  // (`user+x@` and `user!x@` both derive `user-x@`), and refusing those with
  // "an account with this email already exists" would be false — no account
  // with their email exists, and they are not trying to take anything over.
  // Those fall through to the suffix retry below and get their own account.
  const derivedUsername = deriveUsername(normalizedEmail);
  const collision = await db.users.findFirst({
    where: {
      OR: [
        { username: { equals: normalizedEmail, mode: "insensitive" } },
        { username: { equals: derivedUsername, mode: "insensitive" } },
      ],
    },
    include: { identity_links: true },
  });
  // An account already linked to some OTHER external identity is not a local
  // account this person could sign into — it is someone else's SSO account that
  // happens to share a derived handle.
  const isLocalAccount = collision && collision.identity_links.length === 0;
  const isSameAddress =
    collision &&
    collision.username?.toLowerCase() === normalizedEmail.toLowerCase();
  if (collision && (isLocalAccount || isSameAddress))
    throw new IdentityConflictError(
      "An account with this email already exists. Sign in with your existing " +
        "credentials and link this identity provider from your settings."
    );

  // Same address arriving under a DIFFERENT external subject: also a takeover
  // shape, and it must not quietly create a second account holding one identity.
  const emailAlreadyLinked = await db.identity_links.findFirst({
    where: { email: normalizedEmail },
  });
  if (emailAlreadyLinked)
    throw new IdentityConflictError(
      "This email is already linked to another identity. Sign in with the " +
        "original provider and manage links from your settings."
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
  if (!user)
    throw new IdentityConflictError(
      "Could not create an account for this identity. Contact an administrator.",
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
