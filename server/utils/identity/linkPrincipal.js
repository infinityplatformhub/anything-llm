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
  IdentityConflictError,
  IdentityAuthenticationError,
} = require("../identityProviders/errors");

// R2 (PMO ruling): a first-time SSO user is a plain member. Group→role mapping
// is S4's job — "the IdP said they are an admin" is exactly the claim a driver
// must not be trusted with, and doing it here would mean two implementations.
const DEFAULT_ROLE = "default";

/**
 * Usernames are unix-style (`^[a-z][a-z0-9._@-]*$`, 2–64 chars) and an email
 * address already fits, apart from case and the odd unsupported character.
 */
function usernameFromEmail(email) {
  const candidate = String(email).toLowerCase().replace(/[^a-z0-9._@-]/g, "-");
  const trimmed = candidate.replace(/^[^a-z]+/, "").slice(0, 64);
  // A local part that was entirely non-alphabetic would leave nothing valid.
  return trimmed.length >= 2 ? trimmed : `sso-${crypto.randomBytes(6).toString("hex")}`;
}

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
  const collision = await db.users.findFirst({
    where: { username: { equals: normalizedEmail, mode: "insensitive" } },
  });
  if (collision)
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

  const user = await db.users.create({
    data: {
      username: usernameFromEmail(normalizedEmail),
      password: unusablePassword(),
      role: DEFAULT_ROLE,
    },
  });

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

module.exports = { linkPrincipal, usernameFromEmail };
