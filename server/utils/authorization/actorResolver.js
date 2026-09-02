// T-2 (#20): actorResolver — the ONLY place a seam-02 Actor object is constructed
// (grep DoD: no `{type:"user"|"service"|"embed"}` literals outside this file).
// Normalization only, never authentication: each ingress middleware authenticates first
// and leaves its result on response.locals; resolver maps it to an Actor.
// Ingress inventory: p0-5-t2-actor-resolver.md (11 rows).
//
// Single-user mode (R5): NO code path skips checks — the resolver yields an explicit
// service principal carrying the seeded super_admin grant (principal 'single-user').

const prisma = require("../prisma");
const { SystemSettings } = require("../../models/systemSettings");
const { AuthorizationContractError } = require("./errors");

/**
 * issue 45: the credential tables an `apiKeyContext.keyId` may have come from.
 * Adding a row here is a deliberate act — it declares a new id space the resolver must be
 * taught to look up, which is exactly the review this guard exists to force.
 */
const KEY_KINDS = Object.freeze(["api-key", "browser-extension"]);

/**
 * Fail closed on an apiKeyContext whose provenance is missing or unrecognized.
 *
 * Throws rather than returning null on purpose. Returning null would DENY the request,
 * which looks like correct behaviour from the outside and would hide a miswired ingress
 * indefinitely; a throw surfaces it on the first request that ingress serves. Callers that
 * turn AuthorizationContractError into a 500 (requirePermission.js) are doing the right
 * thing here — this is a fault in the wiring, not a decision about a user.
 *
 * Compared exactly: no case folding, no trimming. "Almost the right provenance" is the
 * same class of mistake as none at all.
 */
function assertKeyKind(keyKind) {
  if (typeof keyKind !== "string" || !KEY_KINDS.includes(keyKind)) {
    throw new AuthorizationContractError(
      `apiKeyContext.keyKind must be one of ${KEY_KINDS.join(", ")}; received ${JSON.stringify(keyKind)}`
    );
  }
}

// Hotfix #39: the constants moved to ./principals, which requires nothing —
// this module sits inside a require cycle (systemSettings -> user ->
// legacyRoleGrants -> here) and re-exported constants came back undefined
// depending on load order. Re-exported below so existing importers keep working.
const { SINGLE_USER_ACTOR, SERVICE_PRINCIPALS } = require("./principals");


/**
 * @param {import("express").Request} request
 * @param {import("express").Response} response
 * @returns {Promise<Object|null>} Actor or null when NO ingress authenticated anything.
 */
async function resolveActor(request, response, { db = prisma } = {}) {
  // #30 slice 3 follow-up (Techlead-1 NIT-1): a forgotten `response` must THROW.
  //
  // `response?.locals ?? {}` made the second argument optional in effect: omit it and every
  // branch below misses, so the caller silently receives SINGLE_USER_ACTOR — the widest
  // actor there is. That is the same shape this issue closed three times over (an optional
  // security argument that fails toward MORE access), and it is worse here because the
  // failure produces a valid-looking Actor rather than an error.
  //
  // `arguments.length` rather than a null check, deliberately: an explicit
  // `resolveActor(request, null)` is a caller stating it has no response, which the branches
  // below already handle. Only FORGETTING the argument is the bug.
  if (arguments.length < 2) {
    throw new AuthorizationContractError(
      "resolveActor requires a response — omitting it silently resolves to the single-user actor, which is the widest actor in the system"
    );
  }
  const locals = response?.locals ?? {};

  // Row 3 (P0-4 PR-3): scoped API key — RAW context only; this is where it becomes an Actor.
  //
  // T-4b (#29): a browser-extension key writes apiKeyContext too, but its keyId comes from
  // `browser_extension_api_keys` — a separate table with its own id sequence. Resolving it
  // against `api_keys` would hand extension key 7 the grants of API key 7's creator, an
  // unrelated user. The extension already resolves its own user onto locals.user, so it
  // falls through to the user branch below, which is where its grants belong.
  //
  // issue 45: which table an id came from is DECLARED, never inferred. The branch used to
  // be chosen by exclusion — "not browser-extension" meant api_keys — which held only
  // because both existing ingresses happened to set the tag. A third ingress that wrote an
  // apiKeyContext and forgot it would silently inherit api_keys grants by id collision:
  // no throw, no log, a green suite. Unknown provenance is a contract violation, not a
  // default, so it fails closed before either branch is chosen.
  if (locals.apiKeyContext) assertKeyKind(locals.apiKeyContext.keyKind);
  if (locals.apiKeyContext && locals.apiKeyContext.keyKind !== "browser-extension") {
    const ctx = locals.apiKeyContext;
    // Key lifecycle is checked in full here, not half of it: an expired key must yield
    // no actor even if the ingress middleware ever stops checking (F-20d, QA-2 round 2).
    const expired = ctx.expiresAt && new Date(ctx.expiresAt) <= new Date();
    if (ctx.revokedAt || expired) return null;

    // T-4b (#29) B-1: no grant row ever names `api-key:<id>`, so evaluating the key as its
    // own principal answers `no_grants` for every route. A key is not an identity that can
    // hold policy — it is a bearer credential for its creator, narrowed by its own scopes.
    // Effective permission is grants(createdBy) ∩ scopes(key): the engine resolves grants
    // against `grantPrincipal`, the ingress middleware enforces the scope half, and the
    // `api-key:` id stays as audit provenance.
    const creatorId = await apiKeyCreatorId(ctx.keyId, db);
    const grantPrincipal = await keyGrantPrincipal(creatorId, db);

    // An unbound key inherits its creator's reach; a workspace-bound key keeps its
    // binding and never widens to everything the creator can see.
    const workspaceIds = ctx.workspaceId
      ? [String(ctx.workspaceId)]
      : grantPrincipal
        ? await workspaceIdsForUser(creatorId, db)
        : [];

    return {
      type: "service",
      id: `api-key:${ctx.keyId}`,
      orgId: 1,
      workspaceIds,
      grantPrincipal,
      // A bound key may only narrow its creator's reach; documentFilter intersects with
      // this rather than trusting workspaceIds, which a caller could shape.
      keyWorkspaceBinding: ctx.workspaceId ? [String(ctx.workspaceId)] : [],
      scopedKeyId: String(ctx.keyId),
      attributes: { scopes: ctx.scopes ?? [] },
    };
  }

  // Rows 1/4/5/7: ingresses that resolve a real user row (session JWT, browser-extension
  // key, mobile device token, SSO-exchanged JWT) all land on locals.user.
  if (locals.user) {
    if (locals.user.suspended) return null; // suspended = no actor, engine denies
    // Membership is read here rather than trusted from locals: nothing in the request
    // pipeline populates it today, so trusting it would hand every user an empty scope
    // and make documentFilter match nothing on real routes (B-2, architect review).
    // locals.userWorkspaceIds stays supported as an override for callers that already
    // loaded membership (T-4a route wiring).
    const workspaceIds =
      locals.userWorkspaceIds !== undefined
        ? locals.userWorkspaceIds.map(String)
        : await workspaceIdsForUser(locals.user.id, db);
    return {
      type: "user",
      id: String(locals.user.id),
      orgId: 1,
      workspaceIds,
      impersonatedBy: locals.impersonatedBy ? { type: "user", id: String(locals.impersonatedBy) } : undefined,
    };
  }

  // Row 6: embed config — a REAL actor (anonymous, key-scoped), never null. Absent scope
  // surfaces later as a match-none documentFilter (T-3), not as a deny at ingress.
  if (locals.embedConfig) {
    return {
      type: "embed",
      id: String(locals.embedConfig.uuid),
      orgId: 1,
      workspaceIds: locals.embedConfig.workspace ? [String(locals.embedConfig.workspace.id)] : [],
    };
  }

  // Row 2 (R5): single-user deployments have no user rows — explicit service principal
  // evaluated by the engine like any principal. No branch anywhere may mean "allow".
  if (await isConfirmedSingleUser(db)) {
    return { ...SINGLE_USER_ACTOR };
  }

  // Rows 8-11: agent runtime with null user_id, background jobs, telegram channel state,
  // and unauthenticated routes yield NULL — the engine denies (missing_actor / S-4).
  return null;
}

/**
 * T-4b (#29) W-5: the job-runtime half of the same resolver. `utils/jobs/ActorIdentityStore`
 * used to build Actors independently — it spread the whole `users` row into the object the
 * engine reads, hardcoded `workspaceIds: []` (wrong since T-3 taught the HTTP path to derive
 * membership, so one user read documents over HTTP and nothing in a job), and never stamped
 * `impersonatedBy`, leaving CoreJobWorker's denyImpersonatedMutation with nothing to check.
 *
 * @param {{type: string, id: string|number, orgId?: number, impersonatedBy?: string|number}|null} actorRef
 *   the persisted actor reference on the job row
 * @returns {Promise<Object|null>} Actor, or null when the referenced principal cannot act.
 */
async function resolveActorRef(actorRef, { db = prisma } = {}) {
  if (!actorRef || !actorRef.type || actorRef.id === undefined || actorRef.id === null) {
    return null;
  }

  // Non-user principals (service/embed) carry their whole identity in the ref; there is
  // no row to look up and no membership to derive.
  if (actorRef.type !== "user") {
    return {
      type: actorRef.type,
      id: String(actorRef.id),
      // Same rule as the user branch: the tenant is derived, never taken from the row.
      orgId: 1,
      ...(actorRef.workspaceIds ? { workspaceIds: actorRef.workspaceIds.map(String) } : {}),
    };
  }

  // The row is read to prove the user still exists and may act — never to copy columns
  // into the Actor. Only the seam-02 shape crosses the boundary.
  const user = await db.users.findUnique({
    where: { id: Number(actorRef.id) },
    select: { id: true, suspended: true },
  });
  if (!user || user.suspended) return null;

  return {
    type: "user",
    id: String(user.id),
    // Derived, never read from the job row: orgId decides which org's policy rows are
    // read, so taking it from persisted job data would let a written row pick its own
    // tenant (QA-1). Single-org today; this is the one place that changes when it is not.
    orgId: 1,
    workspaceIds: await workspaceIdsForUser(user.id, db),
    impersonatedBy: actorRef.impersonatedBy
      ? { type: "user", id: String(actorRef.impersonatedBy) }
      : undefined,
  };
}

/**
 * T-4b (#29) W-11: the principal a background job or channel runs as. `jobs/*.js` are
 * standalone scripts that resolved workspaces, chats and documents with no actor at all;
 * a null actor is not a safe default, because the engine denies it and the job breaks
 * silently rather than loudly. Each site chooses: the originating user for per-user work,
 * `core-jobs` for system work.
 *
 * A failed user lookup returns null — it never falls back to the service principal, which
 * would silently escalate a suspended user's queued work to system privileges.
 *
 * @param {{userId?: number|string|null, db?: Object}} input
 * @returns {Promise<Object|null>}
 */
async function jobActor({ userId = null, db = prisma } = {}) {
  if (userId === null || userId === undefined) return { ...SERVICE_PRINCIPALS.coreJobs };
  return resolveActorRef({ type: "user", id: userId }, { db });
}

/**
 * Is the creator of a key still allowed to act?
 *
 * Returns `"active"`, or a reason that denies. Never throws: every failure mode —
 * a missing row, a suspended row, an unreadable table, or a `db` that does not
 * expose `users.findUnique` — resolves to a denial, because the caller turns any
 * non-active answer into "no grant principal".
 *
 * The last case is load-bearing. `resolveActor` accepts an injected `db`, and six
 * test suites hand it an object carrying only the tables they care about. A
 * version of this that assumed `findUnique` exists threw a TypeError from inside
 * the resolver, which the api-key branch has no handler for — measured: 39
 * failures across 7 suites. Throwing is not failing closed; it is failing loudly
 * somewhere else.
 *
 * This is only ever consulted for a NON-NULL creator. The `createdBy === null`
 * branch keeps its own rule (single-user deployments have no user rows to read),
 * and routing it through here would deny every key a single-user instance ever
 * issued — the outage `keyGrantPrincipal`'s comment warns about.
 */
// THREE distinct states, and collapsing any two is a fail-open:
//
//   createdBy null      -> never reaches here. `keyGrantPrincipal` sends it to the
//                          SINGLE_USER path, which a single-user deployment depends on.
//   createdBy dangling  -> "missing". The id points at a row that is gone: `api_keys`
//                          has no foreign key, so a deleted owner leaves the id behind.
//   row present         -> "active" or "suspended", by the column.
//
// (#135 may later sweep orphaned rows on delete; this is the reader half and holds
// whether or not that lands.)
async function creatorStatus(creatorId, db = prisma) {
  try {
    if (typeof db?.users?.findUnique !== "function") return "unreadable";
    const creator = await db.users.findUnique({
      where: { id: Number(creatorId) },
      select: { suspended: true },
    });
    if (!creator) return "missing";
    return creator.suspended ? "suspended" : "active";
  } catch {
    return "unreadable";
  }
}

/**
 * The principal a key's grants resolve against, given its creator id.
 *
 * A null `createdBy` is not always an error. `endpoints/system.js:1073` mints keys with
 * `ApiKey.create(null, name)` and refuses to run in multi-user mode — in a single-user
 * deployment there are no user rows to attribute a key to, and every key ever issued there
 * has a null creator. Denying those would take the whole `/v1` surface offline on upgrade,
 * for the deployments least able to diagnose it.
 *
 * So a creatorless key falls back to the `single-user` service principal, which holds the
 * seeded grants — and ONLY in single-user mode. In multi-user mode a null creator is a real
 * orphan (creator deleted, or a key written outside the model), and it denies.
 *
 * S12 (#136, QA-2): a SUSPENDED creator denies too, and that check belongs here rather than
 * at the point of suspension. `User.update` revokes the keys that exist when it runs — a
 * sweep, and only as good as its coverage. Measured, three paths walked straight past it:
 * `User._update` writes the column without running it, a key minted afterwards was never
 * swept, and re-suspending an already-suspended user sweeps nothing while reporting success.
 *
 * Reading the row here makes the api-key branch symmetric with the two branches that
 * already do it — `locals.user` at :127 and `resolveActorRef` at :201-203 — so suspension
 * is enforced at the READER for every ingress rather than at one writer.
 */
async function keyGrantPrincipal(creatorId, db = prisma) {
  if (creatorId !== null) {
    // Fails CLOSED, and on THREE distinct conditions that must not be collapsed:
    //
    //   the row is gone       -> refuse. A key whose creator was deleted is an orphan
    //                            (QA-2 D3), and "no user found" must never read as
    //                            "not suspended".
    //   the row is suspended  -> refuse. The finding this closes.
    //   the read throws       -> refuse. An unreadable users table denies, the same
    //                            evidence rule the null-creator branch below follows.
    //
    // `creatorSuspended` is a separate helper so the read has ONE error path rather than
    // a `.catch` chained onto a call that may not exist: some callers hand this module a
    // narrow db stub, and an optional-chain here would silently answer "not suspended"
    // for them — which is the fail-open this is meant to prevent.
    const status = await creatorStatus(creatorId, db);
    if (status !== "active") return null;
    return { type: "user", id: String(creatorId) };
  }
  // Gated by the same evidence as the anonymous branch (QA-2 FINDING-1): without it, a key
  // with no creator borrows super_admin the moment the settings read misbehaves.
  if (!(await isConfirmedSingleUser(db))) return null;
  return { type: SINGLE_USER_ACTOR.type, id: SINGLE_USER_ACTOR.id };
}

/**
 * The user a key acts for. `createdBy` is nullable (schema.prisma:20) and the row may be
 * gone, so this returns null rather than a guess — a key with no creator has no grants to
 * intersect and can only deny. An unreadable table denies too: failing toward "some
 * principal" would hand a request whatever that principal holds.
 */
async function apiKeyCreatorId(keyId, db = prisma) {
  try {
    const row = await db.api_keys.findUnique({
      where: { id: Number(keyId) },
      select: { createdBy: true },
    });
    return row?.createdBy ?? null;
  } catch {
    return null;
  }
}

/** Workspace ids the user belongs to — the scope every document filter is built on. */
async function workspaceIdsForUser(userId, db = prisma) {
  try {
    const rows = await db.workspace_users.findMany({
      where: { user_id: Number(userId) },
      select: { workspace_id: true },
    });
    return rows.map((row) => String(row.workspace_id));
  } catch {
    // Fail restrictive: an unreadable membership table yields no scope, which the
    // filter turns into match-none rather than an unbounded read.
    return [];
  }
}

/**
 * Is this deployment REALLY single-user?
 *
 * QA-2 FINDING-1: the setting alone is not evidence. `SystemSettings.isMultiUserMode()`
 * catches its own errors and returns `false` (systemSettings.js:747), so "the database is
 * unreachable" and "the multi_user_mode row is missing" both reach this code as a
 * confident "single-user" — and the catch below used to claim it failed toward the
 * restrictive mode while never actually running. An anonymous request with no credential
 * then resolved to SINGLE_USER_ACTOR, which holds the seeded super_admin grant: delete any
 * workspace, read anything. The missing-row case needs no outage at all — a partial
 * restore, or a migration that drops the row, is enough.
 *
 * So single-user must be CONFIRMED, not merely reported: a deployment with user rows is
 * multi-user whatever the setting says. `isMultiUserMode` itself is left alone — 24
 * callers expect a boolean, and `false` is correct for a genuine single-user install.
 *
 * Both reads fail closed: an unreadable users table denies too, because absence of
 * evidence is not evidence of absence. Returning 0 on that error would simply move
 * FINDING-1 from the settings read to this one.
 *
 * ORDERING NOTE for endpoints/system.js onboarding: the first `User.create` happens BEFORE
 * `multi_user_mode` is written to true. During that window the setting still says
 * single-user while a user row exists, so this returns false and an anonymous request is
 * denied — fail-closed, and deliberate. Do NOT "fix" it by flipping the setting first:
 * that would leave a window where the deployment claims multi-user with no admin in it.
 */
async function isConfirmedSingleUser(db = prisma) {
  try {
    if (await SystemSettings.isMultiUserMode()) return false;
    return (await db.users.count()) === 0;
  } catch {
    return false;
  }
}

module.exports = {
  resolveActor,
  resolveActorRef,
  jobActor,
  // Exported for validatedRequest (#46): session auth had the same swallowed-error hole,
  // and two different answers to "is this single-user?" is how the halves drift apart.
  isConfirmedSingleUser,
  // Exported for the PR-4d scope ceiling (#35): key minting asks the same question the
  // request path asks — which principal do this key's grants resolve against — and a
  // second answer to it is a second place the single-user gate can be forgotten.
  keyGrantPrincipal,
  SINGLE_USER_ACTOR,
  SERVICE_PRINCIPALS,
};
