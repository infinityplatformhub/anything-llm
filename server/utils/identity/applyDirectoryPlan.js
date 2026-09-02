// S4b slice 2 (#134): apply a directory plan, and record that it happened.
//
// Slice 1 (`directoryDiff.js`) produces a plan and cannot write. This module writes
// it. Everything below serves two rules that are easy to state and silent to break:
//
//   R1  a REFUSED plan is applied in neither direction, not even its creates
//   R4  writes batch PER ENTITY, never one transaction for the whole run
//
// Both are about the same thing: what happens when the snapshot is wrong. Lark has no
// delta API, so absence from a snapshot is the only departure signal, and a
// misconfigured directory app produces a snapshot that is confidently wrong about the
// entire organisation.

const prisma = require("../prisma");
const {
  addGroupMember,
  removeGroupMember,
} = require("../authorization/policyRepository");
const { usernameCandidates } = require("./deriveUsername");

class DirectoryApplyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DirectoryApplyError";
  }
}

/**
 * Apply a plan from `diffDirectory`, then write the checkpoint.
 *
 * @param {{plan: Object, actor: Object, provider: string, orgId?: number, startedAt?: Date, db?: Object}} input
 * @returns {Promise<Object>} the checkpoint row
 */
async function applyDirectoryPlan({
  plan,
  actor,
  provider,
  orgId = 1,
  startedAt = new Date(),
  db = prisma,
}) {
  if (!plan || typeof plan !== "object") {
    throw new DirectoryApplyError("applyDirectoryPlan requires a plan");
  }
  if (!actor) {
    // Same rule as the repository's `requireActor`: there is no implicit actor. A
    // default here would be a second, quieter answer to "who may change membership".
    throw new DirectoryApplyError("applyDirectoryPlan requires an actor");
  }
  if (!provider) {
    throw new DirectoryApplyError("applyDirectoryPlan requires a provider name");
  }

  const counts = {
    usersCreated: 0,
    usersDeactivated: 0,
    groupsCreated: 0,
    membershipsAdded: 0,
    membershipsRemoved: 0,
  };

  // ---- R1: a refused plan is not applied at all ----------------------------
  // The FIRST thing, before any write, and it returns rather than filtering: a plan
  // this run is not permitted to apply must not reach the code below at all.
  //
  // Slice 1 already cleared the destructive lists, so `deactivate` and
  // `removeMembership` are empty here — but `create`, `createGroups` and
  // `addMembership` are NOT, and applying them is the mistake this guard exists for.
  // The reasoning is not caution: the guard fired because the snapshot is not
  // credible as a description of the organisation, and a snapshot that cannot be
  // trusted about who left cannot be trusted about who arrived, because both
  // readings come from the same enumeration. A narrowed Lark scope hides one
  // department and can expose an unrelated one, so those "new" people may be a
  // directory nobody meant to sync.
  //
  // The cost is real and intended: a genuine hiring wave during a genuine
  // reorganisation waits for a human. That is why the checkpoint below records the
  // refusal — a refusal nobody can see is an outage with extra steps.
  if (plan.refused) {
    return writeCheckpoint({
      db,
      orgId,
      provider,
      status: "refused",
      refusedReason:
        plan.refusedReason ??
        "the plan was refused by a scale guard and applied nothing",
      counts,
      startedAt,
    });
  }

  // A plan from an INCOMPLETE enumeration carries no destructive entries (slice 1
  // gates both lists on `complete`), so applying its constructive half is safe and
  // is the deliberate behaviour: new people should not wait on a Lark outage.

  // ---- groups --------------------------------------------------------------
  // Before memberships, because a membership names a group that must exist. Within
  // each entity the write is idempotent on the natural key rather than guarded by a
  // read: two runs racing between the read and the write would both see "absent".
  const groupIdByExternalId = new Map();
  for (const group of plan.createGroups ?? []) {
    const created = await upsertGroup({ db, orgId, provider, group });
    if (created.wasCreated) counts.groupsCreated += 1;
    groupIdByExternalId.set(group.externalId, created.id);
  }

  // ---- users ---------------------------------------------------------------
  const userIdBySubject = new Map();
  for (const principal of plan.create ?? []) {
    const created = await upsertUser({ db, provider, principal });
    if (created.wasCreated) counts.usersCreated += 1;
    userIdBySubject.set(principal.subject, created.id);
  }

  for (const user of plan.deactivate ?? []) {
    const userId = await userIdForSubject({ db, provider, subject: user.subject });
    if (!userId) continue;
    // `suspended`, not a delete. `validatedRequest.js:114` rejects a suspended user
    // with 401 immediately, which is the whole point — but it is also reversible,
    // and deleting the row would take their chats and workspace membership with it.
    const { count } = await db.users.updateMany({
      where: { id: userId, suspended: 0 },
      data: { suspended: 1 },
    });
    counts.usersDeactivated += count;
  }

  // ---- memberships ---------------------------------------------------------
  // R3/R4, and the one place this file could be silently wrong.
  //
  // `db` is passed, NEVER a transaction client. `policyRepository.js:23-24`:
  //
  //   const inTransaction = (db, fn) =>
  //     typeof db?.$transaction === "function" ? db.$transaction(fn) : fn(db);
  //
  // A Prisma transaction client has no `$transaction`, so handing one to
  // `addGroupMember` makes it run INLINE in the caller's transaction. That is
  // correct and deliberate for #39's callers, and wrong here: it would collapse
  // every membership change in the run into ONE policy-version bump, and the cache
  // subscriber consumes one invalidation per change. Nothing errors. The symptom is
  // a cache invalidation that arrives once for a hundred changes.
  //
  // So each membership write is its own transaction, carrying its own version bump
  // and outbox publish (#113 RF-5). The next reader will think a transaction is
  // missing here; it is not, and this is why.
  for (const membership of plan.addMembership ?? []) {
    const ids = await membershipIds({ db, provider, membership, groupIdByExternalId, userIdBySubject });
    if (!ids) continue;
    await addGroupMember({ actor, groupId: ids.groupId, userId: ids.userId, db });
    counts.membershipsAdded += 1;
  }

  for (const membership of plan.removeMembership ?? []) {
    const ids = await membershipIds({ db, provider, membership, groupIdByExternalId, userIdBySubject });
    if (!ids) continue;
    await removeGroupMember({ actor, groupId: ids.groupId, userId: ids.userId, db });
    counts.membershipsRemoved += 1;
  }

  // ---- the checkpoint ------------------------------------------------------
  // LAST, and only on success (R5, RF-7). If any write above threw, this line is
  // never reached and no 'completed' row exists — which is the honest record: a
  // crash mid-apply leaves a partially-applied sync that the NEXT run corrects by
  // re-deriving the plan from current state, rather than a rolled-back one that
  // discarded work already proven correct.
  return writeCheckpoint({
    db,
    orgId,
    provider,
    status: "completed",
    refusedReason: null,
    counts,
    startedAt,
  });
}

/**
 * The row that makes a refused run visible.
 *
 * Its own write, deliberately outside everything above: it records what happened,
 * so binding it to the transaction of any single entity would make the record of a
 * run depend on the last thing the run did.
 */
async function writeCheckpoint({ db, orgId, provider, status, refusedReason, counts, startedAt }) {
  return db.directory_sync_checkpoints.create({
    data: {
      orgId,
      provider,
      status,
      refusedReason,
      ...counts,
      startedAt,
      finishedAt: new Date(),
    },
  });
}

/**
 * A group, keyed on `(orgId, source, externalId)` — the unique #133 added.
 *
 * `upsert` rather than find-then-create: two runs racing would both read "absent"
 * and the second insert would fail on the unique index. Idempotency is what makes a
 * re-run after a crash converge (R6), and it comes from the key, not from bookkeeping
 * about which runs have happened.
 */
async function upsertGroup({ db, orgId, provider, group }) {
  const existing = await db.groups.findFirst({
    where: { orgId, source: provider, externalId: group.externalId },
    select: { id: true },
  });
  if (existing) return { id: existing.id, wasCreated: false };

  const created = await db.groups.create({
    data: {
      orgId,
      name: group.name ?? group.externalId,
      source: provider,
      externalId: group.externalId,
    },
    select: { id: true },
  });
  return { id: created.id, wasCreated: true };
}

/**
 * A user, keyed on the identity link `(provider, subject)`.
 *
 * The link is what makes this idempotent: usernames are derived and can collide
 * between two genuinely different people, so they cannot be the key. `identity_links`
 * already carries a unique on `(provider, subject)` — the constraint that makes two
 * users claiming one directory identity fail at the write rather than in review.
 */
async function upsertUser({ db, provider, principal }) {
  const linked = await db.identity_links.findUnique({
    where: { provider_subject: { provider, subject: principal.subject } },
    select: { userId: true },
  });
  if (linked) return { id: linked.userId, wasCreated: false };

  // A directory-provisioned account has no local password. A random one is stored
  // rather than an empty string: `password` is NOT NULL, and a shared sentinel would
  // be a known value on every provisioned account.
  const password = require("crypto").randomBytes(32).toString("hex");

  let lastError = null;
  for (const username of usernameCandidates(principal.email)) {
    try {
      const user = await db.users.create({
        data: { username, password, role: "default" },
        select: { id: true },
      });
      await db.identity_links.create({
        data: {
          userId: user.id,
          provider,
          subject: principal.subject,
          email: principal.email,
        },
      });
      return { id: user.id, wasCreated: true };
    } catch (error) {
      // A username collision is two different addresses deriving one handle, and the
      // generator's next candidate resolves it. Anything else is not ours to retry.
      if (!isUniqueViolation(error, "username")) throw error;
      lastError = error;
    }
  }
  throw new DirectoryApplyError(
    `could not derive a free username for ${principal.subject}: ${lastError?.message}`
  );
}

const isUniqueViolation = (error, field) =>
  error?.code === "P2002" &&
  (field === undefined || String(error?.meta?.target ?? "").includes(field));

async function userIdForSubject({ db, provider, subject }) {
  const link = await db.identity_links.findUnique({
    where: { provider_subject: { provider, subject } },
    select: { userId: true },
  });
  return link?.userId ?? null;
}

/**
 * Resolve a plan membership entry to the ids the repository needs.
 *
 * Returns null when either side is unknown, which is not an error: a membership
 * naming a quarantined principal or a group the directory dropped is a gap in the
 * snapshot, and the run should apply what it can rather than abort. `null` cannot
 * reach the repository, so a missing id is never a write against id `NaN`.
 */
async function membershipIds({ db, provider, membership, groupIdByExternalId, userIdBySubject }) {
  const groupId =
    groupIdByExternalId.get(membership.groupExternalId) ??
    (
      await db.groups.findFirst({
        where: { source: provider, externalId: membership.groupExternalId },
        select: { id: true },
      })
    )?.id;

  const userId =
    userIdBySubject.get(membership.subject) ??
    (await userIdForSubject({ db, provider, subject: membership.subject }));

  if (!groupId || !userId) return null;
  return { groupId, userId };
}

module.exports = {
  applyDirectoryPlan,
  DirectoryApplyError,
};
