// S4b slice 3 (#138): one directory sync run, end to end.
//
// This is the seam between the three slices, and it is deliberately thin: slice 1
// (`directoryDiff`) decides WHAT should change, slice 2 (`applyDirectoryPlan`) writes
// it and records the checkpoint, and this file only reads current state and hands the
// pieces to each other in order.
//
// Nothing here decides policy. A "small" decision made in this file — which principals
// count, whether a refusal may be overridden, who the actor is — would be a second
// answer to a question one of the slices already owns, and the two would drift.

const prisma = require("../prisma");
const {
  enumerateDirectory,
  diffDirectory,
} = require("./directoryDiff");
const { applyDirectoryPlan } = require("./applyDirectoryPlan");

class DirectorySyncError extends Error {
  constructor(message) {
    super(message);
    this.name = "DirectorySyncError";
  }
}

/**
 * Read the state the diff compares the snapshot against.
 *
 * Users are keyed by their identity link, not by email or username: the link's
 * `(provider, subject)` unique is the only stable identity, and matching on anything
 * else is slice 4's Q4-blocked question rather than something to guess here.
 *
 * `suspended` is carried through because slice 1 excludes already-suspended users from
 * `deactivate` — without it, every sync would "deactivate" the same departed people
 * again and the scale guard would count them every time.
 */
async function readCurrentState({ db, provider, orgId }) {
  const links = await db.identity_links.findMany({
    where: { provider },
    select: { subject: true, userId: true, user: { select: { suspended: true } } },
  });

  const groups = await db.groups.findMany({
    where: { orgId, source: provider },
    select: { id: true, externalId: true },
  });

  const userIdBySubject = new Map(links.map((l) => [l.subject, l.userId]));
  const subjectByUserId = new Map(links.map((l) => [l.userId, l.subject]));
  const externalIdByGroupId = new Map(groups.map((g) => [g.id, g.externalId]));

  const memberships = await db.group_members.findMany({
    where: {
      group_id: { in: groups.map((g) => g.id) },
      user_id: { in: links.map((l) => l.userId) },
    },
    select: { group_id: true, user_id: true },
  });

  return {
    users: links.map((l) => ({
      subject: l.subject,
      suspended: Boolean(l.user?.suspended),
    })),
    groups: groups.map((g) => ({ externalId: g.externalId })),
    // Only memberships whose BOTH ends are directory-managed. A membership in a local
    // group, or of a locally-created user, is not the directory's to remove — and
    // since absence from a snapshot is how removal is decided, including them would
    // make every sync strip local grants.
    memberships: memberships
      .map((m) => ({
        subject: subjectByUserId.get(m.user_id),
        groupExternalId: externalIdByGroupId.get(m.group_id),
      }))
      .filter((m) => m.subject && m.groupExternalId),
    userIdBySubject,
  };
}

/**
 * Enumerate, diff, apply, checkpoint.
 *
 * The `lease` is threaded through rather than resolved here (TL-2, #138): only the
 * job runtime knows which worker holds this run, and a sync started outside the queue
 * has no lease to check. It is passed to the applier untouched — this file decides no
 * policy, including this one.
 *
 * @param {{provider: string, actor: Object, driver?: Object, orgId?: number, db?: Object, lease?: Object}} input
 * @returns {Promise<Object>} the checkpoint row
 */
async function runDirectorySync({ provider, actor, driver, orgId = 1, db = prisma, lease = null }) {
  if (!provider) throw new DirectorySyncError("runDirectorySync requires a provider");
  if (!actor) {
    // Same rule as the repository and the applier: no implicit actor. The job runtime
    // resolves it through `identityStore.resolveActor` and fails the job when the
    // principal may no longer act (#134 RF-6), so arriving here without one means
    // that check was bypassed, not that a default is wanted.
    throw new DirectorySyncError("runDirectorySync requires an actor");
  }

  const startedAt = new Date();
  const resolved = driver ?? (await driverFor({ db, provider }));

  // Enumerate FIRST, and let it throw. `enumerateDirectory` is the only producer of a
  // completed enumeration (#134 R2): if either call fails, no branded value exists and
  // the diff can never read absence as departure. A `catch` here that continued with
  // partial data would defeat the entire type discipline — so there isn't one.
  const enumeration = await enumerateDirectory(resolved);

  const current = await readCurrentState({ db, provider, orgId });
  const plan = diffDirectory({ enumeration, current });

  return applyDirectoryPlan({ plan, actor, provider, orgId, startedAt, db, lease });
}

/**
 * The configured, ENABLED provider driver.
 *
 * GAP, recorded rather than worked around (#138): LARK CANNOT BE RESOLVED HERE YET.
 * `LarkIdentityProvider` is not in the registry (`utils/identityProviders/index.js`
 * lists oidc, saml, ldap), and `identity_providers` has no `appId`/`appSecret`
 * columns — its secret would belong in `CredentialStore` like LDAP's bind password.
 * So configuring a Lark provider is a slice of its own, not a line in this file.
 *
 * This function is therefore reachable today only for a provider that IS registered
 * and directory-capable. `runDirectorySync` takes an injected `driver` for exactly
 * this reason, which is also how the tests drive it. Making this resolve Lark by
 * special-casing it here would put provider configuration in the sync runner, where
 * nobody would look for it.
 *
 * A disabled provider throws rather than returning an empty enumeration. An empty
 * enumeration from a completed run means "everyone left", and slice 1 would plan the
 * deactivation of the entire organisation — the scale guard would refuse it, but a
 * refusal caused by our own configuration is an alert nobody can act on.
 */
async function driverFor({ db, provider }) {
  const row = await db.identity_providers.findUnique({ where: { provider } });
  if (!row || !row.enabled) {
    throw new DirectorySyncError(
      `directory sync requires an enabled '${provider}' provider; ` +
        `${row ? "it is disabled" : "none is configured"}`
    );
  }
  const { getIdentityProvider, providerCapabilities } = require("../identityProviders");

  // Refused BEFORE construction: `directorySync: false` means the driver has no
  // `listPrincipals`, and `enumerateDirectory` would reject it — but with a message
  // about a missing method rather than about a provider that cannot do this at all.
  if (!providerCapabilities(provider).directorySync) {
    throw new DirectorySyncError(
      `provider '${provider}' does not support directory sync`
    );
  }
  return getIdentityProvider(provider, configFor(row));
}

/**
 * The `identity_providers` row as a driver's constructor arguments.
 *
 * One table holds every provider's shape (SAML certificates, LDAP bind DN, ...), so
 * each driver takes the half that applies to it and ignores the rest. Secrets are NOT
 * here: the bind password and the Lark app secret live in `CredentialStore`, and
 * pulling them into this object would put them in every error and log line that
 * serialises the config.
 */
function configFor(row) {
  return {
    ldapUrl: row.ldapUrl,
    baseDn: row.baseDn,
    bindDn: row.bindDn,
    entityId: row.entityId,
    ssoUrl: row.ssoUrl,
    certificates: row.certificates,
  };
}

module.exports = { runDirectorySync, readCurrentState, DirectorySyncError };
