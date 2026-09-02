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
//
// RESIDUALS — what this module does NOT provide, written here because slice 3 reads
// the checkpoint and would otherwise infer these guarantees from its shape:
//
// 1. STATUS 'failed' IS NEVER WRITTEN. The migration admits it, and nothing produces
//    it: a crash mid-apply propagates the error and the checkpoint write is simply
//    never reached (that is R5/RF-7 working — no row is better than a row claiming a
//    run finished). The consequence is that a crashed run and a run that never
//    started are the same absence. **Slice 3 must not read "no row" as "never ran"**
//    when deciding whether a sync is overdue; that inference is wrong precisely in
//    the case that matters. Writing 'failed' needs a durable catch that survives the
//    crash it records, which is slice 3's concurrency work, not this module's.
//
// 2. THE COUNTS ARE CALLS, NOT NET CHANGES. `membershipsAdded` counts invocations of
//    `addGroupMember`, and that call is an upsert — re-applying a converged plan
//    reports 1, not 0, because the row was written idempotently rather than skipped.
//    `usersCreated` and `groupsCreated` DO reflect real creations (both check first).
//    So the membership counts answer "how much work was attempted", not "what
//    changed", and an operator reading them as a change log will over-report.
//    Measured, applying one plan twice:
//      first  apply: usersCreated 1, groupsCreated 1, membershipsAdded 1
//      second apply: usersCreated 0, groupsCreated 0, membershipsAdded 1
//    with `group_members` still holding exactly one row.
//
// 3. THE LEASE GUARD IS PER ENTITY, NOT PER WRITE (TL-2, #138). `lease` is checked
//    BETWEEN entities, so a worker that loses its lease stops at the next boundary
//    rather than mid-entity. Each entity's own write is already atomic — one
//    `addGroupMember` is one transaction — so the guard cannot leave half an entity
//    behind. What it does NOT do is make the check and the write one atomic step:
//    a lease can expire in the microseconds between them, and that entity still
//    lands. The window is one entity wide instead of a whole run, which is a
//    reduction rather than an elimination. Closing it entirely needs the predicate
//    inside each repository write — a policyRepository change, not this module's.

const prisma = require("../prisma");
const {
  addGroupMember,
  removeGroupMember,
} = require("../authorization/policyRepository");
const { usernameCandidates } = require("./deriveUsername");
const { LeaseLostError } = require("../jobs/errors");

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
  lease = null,
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

  // ---- the lease guard (TL-2, #138) ----------------------------------------
  // Losing a lease used to be discovered at `complete()` — after the handler had run
  // to the end and committed every row. So a worker that STALLED rather than died
  // (a long GC pause, a throttled container, a wedged socket) would have its job taken
  // over, and would then wake up and go on writing into a directory a second worker
  // had already reconciled. Two applies in flight is precisely what this slice exists
  // to prevent, and "worker 2 took over" never implied "only worker 2 wrote".
  //
  // The predicate is the CLAIM's own, verbatim: this row, this worker, still running,
  // lease not yet expired. Reusing it is the point — a guard that asked a slightly
  // different question would let exactly the rows through that the claim would refuse.
  //
  // Optional, and absent means unguarded. `applyDirectoryPlan` is called directly by
  // tests and by any future caller that is not a job; requiring a lease would make
  // them invent one, and an invented lease is a guard that always passes.
  const assertLease = async () => {
    if (!lease) return;
    if (lease.beforeEntity) await lease.beforeEntity();
    const held = await db.jobs.count({
      where: {
        id: lease.jobId,
        workerId: lease.workerId,
        state: { in: ["running", "cancelling"] },
        leaseUntil: { gt: new Date() },
      },
    });
    if (held !== 1) {
      throw new LeaseLostError(
        `directory sync lost its lease mid-apply (job ${lease.jobId}, worker ${lease.workerId}); ` +
          `another worker has taken this run and the remaining writes were refused`
      );
    }
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
    await assertLease();
    const created = await upsertGroup({ db, orgId, provider, group });
    if (created.wasCreated) counts.groupsCreated += 1;
    groupIdByExternalId.set(group.externalId, created.id);
  }

  // ---- users ---------------------------------------------------------------
  const userIdBySubject = new Map();
  for (const principal of plan.create ?? []) {
    await assertLease();
    const created = await upsertUser({ db, provider, principal });
    if (created.wasCreated) counts.usersCreated += 1;
    userIdBySubject.set(principal.subject, created.id);
  }

  for (const user of plan.deactivate ?? []) {
    await assertLease();
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
  // `addGroupMember` makes it run INLINE in the caller's transaction instead of
  // opening its own. Passing `db` means each call gets its own transaction,
  // carrying its own version bump and outbox publish (#113 RF-5). The next reader
  // will think a transaction is missing here; it is not, and this is why.
  //
  // WHAT PASSING A TX WOULD AND WOULD NOT CHANGE — measured, because the earlier
  // version of this comment claimed the wrong thing. It does NOT collapse the
  // version bumps: `bumpVersion` runs once per `addGroupMember` invocation either
  // way, so N changes produce N `policy_versions` rows and N outbox rows whether a
  // tx or `db` is passed. Verified against a real database, and confirmed
  // independently by TL-1 and by QA-1's MB mutant (whole loop in one transaction:
  // 3 changes, 3 bumps, 3 outbox rows, suite green).
  //
  // What it WOULD change is rollback scope and lock duration. One transaction across
  // the loop means a single conflicting row discards every membership change in the
  // run, and a 100-page org holds its locks for the whole apply. Per entity, a
  // mid-run failure leaves the earlier entries committed, and the next run re-derives
  // the remainder from current state (R6) — which is the behaviour RF-4 pins.
  //
  // The risk this comment guards is therefore a future refactor that batches these
  // writes for speed. NO TEST PINS IT: the difference is invisible to a row count,
  // and observing it needs a conflict fixture. Recorded as a §7.9 survivor (M2/M3 in
  // .infi/ledger-134.md), not silently assumed to be covered.
  for (const membership of plan.addMembership ?? []) {
    await assertLease();
    const ids = await membershipIds({ db, provider, membership, groupIdByExternalId, userIdBySubject });
    if (!ids) continue;
    await addGroupMember({ actor, groupId: ids.groupId, userId: ids.userId, db });
    counts.membershipsAdded += 1;
  }

  for (const membership of plan.removeMembership ?? []) {
    await assertLease();
    const ids = await membershipIds({ db, provider, membership, groupIdByExternalId, userIdBySubject });
    if (!ids) continue;
    await removeGroupMember({ actor, groupId: ids.groupId, userId: ids.userId, db });
    counts.membershipsRemoved += 1;
  }

  // ---- the checkpoint ------------------------------------------------------
  // Guarded like every entity above: a checkpoint written by a worker that lost its
  // lease would record a completed run on top of the one that actually happened, and
  // it is the checkpoint that slice 3 reads to decide whether a sync is overdue.
  await assertLease();

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
