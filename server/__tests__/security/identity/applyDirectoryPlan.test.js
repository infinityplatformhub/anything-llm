/**
 * S4b slice 2 (#134): apply a directory plan, and record that it happened.
 *
 * Slice 1 computes a plan and cannot write. These tests cover the module that writes
 * it, and the two rules that are easy to state and silent to break:
 *
 *   R1  a REFUSED plan is applied in neither direction, not even its creates
 *   R4  writes batch PER ENTITY — one policy_versions row per membership change
 *
 * WHAT THESE TESTS REFUSE TO DO. "Rows were written" is green for a reconciler that
 * writes one row for a hundred changes — which is exactly the F1 failure, where
 * passing a `tx` to addGroupMember silently collapses every bump into one. So every
 * count here is asserted against the NUMBER OF CHANGES, never against non-empty.
 *
 * And every "X was written" test is paired with one proving the same path leaves X
 * alone when it should: RF-1 (a refused plan writes nothing) is satisfied by a
 * reconciler that never writes at all, so RF-2 runs the same fixture accepted.
 */

const { execSync } = require("child_process");
const path = require("path");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const baseDatabaseUrl = process.env.DATABASE_URL;
const SERVER_DIR = path.join(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");

const dbSuffix = crypto.randomBytes(4).toString("hex");
const testDb = `s4b2_apply_${dbSuffix}`;
const testUrl = baseDatabaseUrl?.replace(/\/[^/?]+(\?|$)/, `/${testDb}$1`);

let prisma;

beforeAll(async () => {
  if (!baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    throw new Error("#134 requires DATABASE_URL pointing at PostgreSQL");
  }
  const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${testDb}"`);
  await admin.$disconnect();
  execSync(`npx prisma migrate deploy --schema ${SCHEMA}`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  execSync(`node prisma/seed.js`, {
    env: { ...process.env, DATABASE_URL: testUrl },
    cwd: SERVER_DIR,
    stdio: "pipe",
  });
  prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
}, 300_000);

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  if (baseDatabaseUrl?.startsWith(PG_SCHEME)) {
    const admin = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDb}" WITH (FORCE)`);
    await admin.$disconnect();
  }
}, 60_000);

const {
  applyDirectoryPlan,
} = require("../../../utils/identity/applyDirectoryPlan");
const {
  diffDirectory,
  enumerateDirectory,
  __testHelpers__: { completedEnumeration },
  DirectoryDiffError,
} = require("../../../utils/identity/directoryDiff");
const { SERVICE_PRINCIPALS } = require("../../../utils/authorization/principals");
const { resolveActorRef } = require("../../../utils/authorization/actorResolver");

const PROVIDER = "lark";
const CORE_JOBS = SERVICE_PRINCIPALS.coreJobs;

/** A DirectoryPrincipal as S4a's driver returns one. */
const principal = (subject, overrides = {}) => ({
  provider: PROVIDER,
  subject: `${subject}-${dbSuffix}`,
  email: `${subject}-${dbSuffix}@corp.example.com`,
  emailVerified: false,
  active: true,
  displayName: subject,
  groupExternalIds: [],
  revision: null,
  ...overrides,
});

const group = (externalId, name = externalId) => ({
  provider: PROVIDER,
  externalId: `${externalId}-${dbSuffix}`,
  name: `${name}-${dbSuffix}`,
  memberExternalIds: [],
});

/** Counts every table an apply can touch, so "nothing happened" is measurable. */
async function census() {
  const [users, groups, members, versions, outbox, checkpoints] = await Promise.all([
    prisma.users.count(),
    prisma.groups.count(),
    prisma.group_members.count(),
    prisma.policy_versions.count(),
    prisma.event_outbox.count(),
    prisma.directory_sync_checkpoints.count(),
  ]);
  return { users, groups, members, versions, outbox, checkpoints };
}

describe("#134 R1: a refused plan applies NOTHING, in either direction", () => {
  test("RF-1: a refused plan writes zero rows across every table", async () => {
    // The fixture carries a CONSTRUCTIVE half, deliberately. Slice 1 clears only the
    // destructive lists when a guard fires, so `create`/`createGroups`/
    // `addMembership` survive into the plan — and applying them is precisely the
    // mistake this guard exists to prevent. A fixture with no creates would pass
    // against an applier that happily created everyone.
    const dept = group("refused-dept");

    // 100 users, all present, all with their department gone: the narrowed-scope
    // shape. Nobody looks departed, so the DEACTIVATION guard never fires; the
    // MEMBERSHIP guard is what refuses.
    const held = Array.from({ length: 100 }, (_, i) => ({
      subject: `refused-u${i}-${dbSuffix}`,
      groupExternalId: dept.externalId,
    }));
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [
          ...Array.from({ length: 100 }, (_, i) => principal(`refused-u${i}`)),
          // 60 arrivals, which a credible snapshot would have us create.
          ...Array.from({ length: 60 }, (_, i) => principal(`refused-new${i}`)),
        ],
        groups: [dept],
      }),
      current: {
        users: Array.from({ length: 100 }, (_, i) => ({
          subject: `refused-u${i}-${dbSuffix}`,
          suspended: false,
        })),
        groups: [],
        memberships: held,
      },
    });

    // The fixture must sit where the named guard is the only thing deciding this.
    expect(plan.refused).toBe(true);
    expect(plan.create.length).toBe(60);
    expect(plan.createGroups.length).toBe(1);

    const before = await census();
    const checkpoint = await applyDirectoryPlan({
      plan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });
    const after = await census();

    expect(after.users).toBe(before.users);
    expect(after.groups).toBe(before.groups);
    expect(after.members).toBe(before.members);
    expect(after.versions).toBe(before.versions);
    expect(after.outbox).toBe(before.outbox);

    // RF-5's half: the run IS recorded, and says why.
    expect(after.checkpoints).toBe(before.checkpoints + 1);
    expect(checkpoint.status).toBe("refused");
    expect(checkpoint.refusedReason).toMatch(/scale guard/);
  }, 120_000);
});

describe("#134 R3/R4: an accepted plan applies, per entity", () => {
  test("RF-2: two membership changes produce TWO policy_versions and TWO outbox rows", async () => {
    // The control RF-1 needs: without it, a reconciler that never writes anything
    // passes RF-1 and RF-5 and looks correct.
    //
    // What it pins: two membership changes produce exactly TWO policy_versions rows
    // and TWO event_outbox rows, COUNTED against the number of changes, AND the two
    // memberships exist. Both halves are needed and neither implies the other — a
    // bump with no write passes the membership assertion's absence, and a write with
    // no bump passes a row-existence check. "Not empty" is green for one row, so the
    // count is the assertion, never the presence.
    //
    // NOT the F1 witness, and the pre-read's proposed one cannot exist. F1 predicted
    // that passing a `tx` to addGroupMember collapses N changes into one bump.
    // Measured on a real database through the real repository, it does not: two
    // changes produce two rows whether a tx or `prisma` is passed, because
    // `bumpVersion` runs once per invocation either way. Mutants M2 (per-call
    // $transaction) and M3 (one transaction around the whole loop) both SURVIVE this
    // suite, recorded as survivors with their reachability per §7.9 — see
    // .infi/ledger-134.md. The pass-`prisma` rule stands on rollback scope and lock
    // duration, which no row count can observe.
    const deptA = group("rf2-a");
    const deptB = group("rf2-b");
    const alice = principal("rf2-alice", {
      groupExternalIds: [deptA.externalId, deptB.externalId],
    });

    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [alice],
        groups: [deptA, deptB],
      }),
      current: { users: [], groups: [], memberships: [] },
    });
    expect(plan.refused).toBe(false);
    expect(plan.addMembership.length).toBe(2);

    const versionsBefore = await prisma.policy_versions.count();
    const outboxBefore = await prisma.event_outbox.count();

    const checkpoint = await applyDirectoryPlan({
      plan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });

    const versionsAfter = await prisma.policy_versions.count();
    const outboxAfter = await prisma.event_outbox.count();

    expect(versionsAfter - versionsBefore).toBe(2);
    expect(outboxAfter - outboxBefore).toBe(2);

    // And the membership actually exists — a bump with no write would pass above.
    const link = await prisma.identity_links.findUnique({
      where: { provider_subject: { provider: PROVIDER, subject: alice.subject } },
    });
    expect(link).toBeTruthy();
    const members = await prisma.group_members.count({
      where: { user_id: link.userId },
    });
    expect(members).toBe(2);

    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.refusedReason).toBeNull();
    expect(checkpoint.membershipsAdded).toBe(2);
    expect(checkpoint.usersCreated).toBe(1);
    expect(checkpoint.groupsCreated).toBe(2);
  }, 120_000);
});

describe("#134 R1 control: an ACCEPTED plan does apply its destructive half", () => {
  test("RF-2b: a departure suspends the user and removes the membership, counted", async () => {
    // Without this, every refusal test above is satisfied by an applier that never
    // deactivates and never removes anyone — which passes RF-1, passes RF-5, and
    // makes the whole reconciler a no-op in the direction that matters. Three
    // mutants survived until this existed: skipping the deactivate loop, skipping
    // the removeMembership loop, and zeroing the deactivation count.
    const dept = group("rf2b-dept");
    const staying = principal("rf2b-staying", { groupExternalIds: [dept.externalId] });
    const leaving = principal("rf2b-leaving", { groupExternalIds: [dept.externalId] });

    // Establish both people in the department.
    await applyDirectoryPlan({
      plan: diffDirectory({
        enumeration: completedEnumeration({
          principals: [staying, leaving],
          groups: [dept],
        }),
        current: { users: [], groups: [], memberships: [] },
      }),
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });

    const links = await prisma.identity_links.findMany({
      where: { provider: PROVIDER, subject: { in: [staying.subject, leaving.subject] } },
      select: { subject: true, userId: true },
    });
    expect(links).toHaveLength(2);
    const userIdOf = (subject) => links.find((l) => l.subject === subject).userId;
    const deptRow = await prisma.groups.findFirstOrThrow({
      where: { source: PROVIDER, externalId: dept.externalId },
    });

    // The next snapshot: `leaving` is gone, and `staying` has left the department
    // but is still employed. Two DIFFERENT outcomes from one run, which is the pair
    // an applier can conflate — deactivating someone who merely changed department
    // is the revocation slice 1's guards exist to make rare rather than impossible.
    const plan = diffDirectory({
      enumeration: completedEnumeration({
        principals: [{ ...staying, groupExternalIds: [] }],
        groups: [dept],
      }),
      current: {
        users: [
          { subject: staying.subject, suspended: false },
          { subject: leaving.subject, suspended: false },
        ],
        groups: [{ externalId: dept.externalId }],
        memberships: [
          { subject: staying.subject, groupExternalId: dept.externalId },
          { subject: leaving.subject, groupExternalId: dept.externalId },
        ],
      },
    });
    // Small numbers, well under both floors, so the scale guards cannot be what
    // decides this — the fixture must sit where the APPLIER is the only variable.
    expect(plan.refused).toBe(false);
    expect(plan.deactivate.map((u) => u.subject)).toEqual([leaving.subject]);
    expect(plan.removeMembership).toHaveLength(2);

    const versionsBefore = await prisma.policy_versions.count();
    const checkpoint = await applyDirectoryPlan({
      plan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });
    const versionsAfter = await prisma.policy_versions.count();

    // Departed: suspended, which `validatedRequest.js:114` turns into an immediate
    // 401. Not deleted — reversible, and a delete would take their chats with it.
    const departed = await prisma.users.findUniqueOrThrow({
      where: { id: userIdOf(leaving.subject) },
    });
    expect(departed.suspended).toBe(1);

    // Still employed: NOT suspended, just out of the department.
    const remains = await prisma.users.findUniqueOrThrow({
      where: { id: userIdOf(staying.subject) },
    });
    expect(remains.suspended).toBe(0);

    // Both memberships gone, and COUNTED per change (R4): two removals means two
    // version rows, which is the assertion that stays red for a batched applier.
    const members = await prisma.group_members.count({ where: { group_id: deptRow.id } });
    expect(members).toBe(0);
    expect(versionsAfter - versionsBefore).toBe(2);

    expect(checkpoint.usersDeactivated).toBe(1);
    expect(checkpoint.membershipsRemoved).toBe(2);
  }, 180_000);
});

describe("#134 R4: a membership naming something that no longer exists is skipped, not written", () => {
  test("a subject deleted between plan and apply does not abort the run or write a bad id", async () => {
    // Reachable, not defensive. The apply phase is deliberately long and batched per
    // entity (R4), so state CAN change under it: an admin deletes a user, or a group
    // is removed, between the read that produced `current` and the write. The plan
    // still names them.
    //
    // Two wrong answers this pins at once. Aborting the run would let one deleted
    // row discard an entire otherwise-correct sync. Writing anyway would resolve to
    // an undefined id — `Number(undefined)` is NaN, and the repository would either
    // throw deep inside a version bump or write against a garbage key.
    const dept = group("gap-dept");
    const real = principal("gap-real", { groupExternalIds: [dept.externalId] });

    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals: [real], groups: [dept] }),
      current: { users: [], groups: [], memberships: [] },
    });
    // A membership naming a subject that will never exist, alongside a valid one.
    plan.addMembership.push({
      subject: `gap-ghost-${dbSuffix}`,
      groupExternalId: dept.externalId,
    });
    // ...and one naming a group that does not exist.
    plan.addMembership.push({
      subject: real.subject,
      groupExternalId: `gap-missing-dept-${dbSuffix}`,
    });
    expect(plan.addMembership).toHaveLength(3);

    const versionsBefore = await prisma.policy_versions.count();
    const checkpoint = await applyDirectoryPlan({
      plan, actor: CORE_JOBS, provider: PROVIDER, db: prisma,
    });
    const versionsAfter = await prisma.policy_versions.count();

    // The run completed, and applied exactly the ONE membership it could resolve.
    // Counting is what distinguishes "skipped the gaps" from "wrote all three": an
    // applier that resolved ghosts to NaN would bump three times or throw.
    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.membershipsAdded).toBe(1);
    expect(versionsAfter - versionsBefore).toBe(1);

    const link = await prisma.identity_links.findUniqueOrThrow({
      where: { provider_subject: { provider: PROVIDER, subject: real.subject } },
    });
    const memberships = await prisma.group_members.count({
      where: { user_id: link.userId },
    });
    expect(memberships).toBe(1);
  }, 180_000);
});

describe("#134 R2: enumerateDirectory is the only producer of a completed enumeration", () => {
  test("RF-3: a second call that throws produces NO branded value, and the diff never sees the first call's data", async () => {
    // Asserting only that enumerateDirectory threw is weaker than it looks: the
    // mistake worth catching is a caller that catches and continues with the
    // principals it already has. So the diff is driven with whatever survived, and
    // must refuse to treat it as complete.
    let principalsFromFailedRun = null;
    const driver = {
      listPrincipals: async () => {
        const page = {
          principals: [principal("rf3-still-here")],
          nextCursor: null,
          hasMore: false,
        };
        principalsFromFailedRun = page.principals;
        return page;
      },
      listGroups: async () => {
        throw new Error("Lark 500");
      },
    };

    await expect(enumerateDirectory(driver)).rejects.toThrow("Lark 500");

    // The first call DID return data. That is the trap: it looks authoritative.
    expect(principalsFromFailedRun).toHaveLength(1);

    // A caller that continued with it gets a plan with no deactivations, because the
    // value it can build is not branded.
    const plan = diffDirectory({
      enumeration: { status: "failed", principals: principalsFromFailedRun, groups: [] },
      current: {
        users: [{ subject: "rf3-departed", suspended: false }],
        groups: [],
        memberships: [],
      },
    });
    expect(plan.complete).toBe(false);
    expect(plan.deactivate).toEqual([]);

    // And it cannot be re-branded by hand: the raw object claiming completeness is
    // refused outright.
    expect(() =>
      diffDirectory({
        enumeration: { status: "complete", principals: principalsFromFailedRun, groups: [] },
        current: { users: [{ subject: "rf3-departed", suspended: false }], groups: [], memberships: [] },
      })
    ).toThrow(DirectoryDiffError);
  });

  test("N-2: a driver returning a PARTIAL page without throwing is refused", async () => {
    // The shape is asserted, not inferred from the driver's behaviour. S4a refuses
    // to return a prefix today, so this can only fail through a future driver — and
    // that driver would otherwise have its prefix branded complete, after which
    // absence from it deactivates everyone it skipped.
    const partial = {
      listPrincipals: async () => ({
        principals: [principal("n2-prefix")],
        nextCursor: "page-2",
        hasMore: true,
      }),
      listGroups: async () => ({ groups: [], nextCursor: null, hasMore: false }),
    };
    await expect(enumerateDirectory(partial)).rejects.toThrow(/PARTIAL/);

    // hasMore alone is enough — a driver that forgets to clear one field is the
    // realistic version of this.
    const halfPartial = {
      listPrincipals: async () => ({
        principals: [principal("n2-half")],
        nextCursor: null,
        hasMore: true,
      }),
      listGroups: async () => ({ groups: [], nextCursor: null, hasMore: false }),
    };
    await expect(enumerateDirectory(halfPartial)).rejects.toThrow(/PARTIAL/);

    // And the GROUPS call is checked too, not just the first one.
    const partialGroups = {
      listPrincipals: async () => ({ principals: [], nextCursor: null, hasMore: false }),
      listGroups: async () => ({
        groups: [group("n2-g")],
        nextCursor: "more",
        hasMore: true,
      }),
    };
    await expect(enumerateDirectory(partialGroups)).rejects.toThrow(/PARTIAL/);
  });

  test("a complete pair IS branded, and drives deactivation", async () => {
    // The control. Every refusal above is satisfied by an enumerateDirectory that
    // always throws.
    const driver = {
      listPrincipals: async () => ({
        principals: [principal("n2-present")],
        nextCursor: null,
        hasMore: false,
      }),
      listGroups: async () => ({ groups: [], nextCursor: null, hasMore: false }),
    };
    const enumeration = await enumerateDirectory(driver);
    const plan = diffDirectory({
      enumeration,
      current: {
        users: [{ subject: `n2-departed-${dbSuffix}`, suspended: false }],
        groups: [],
        memberships: [],
      },
    });
    expect(plan.complete).toBe(true);
    expect(plan.deactivate.map((u) => u.subject)).toEqual([`n2-departed-${dbSuffix}`]);
  });

  test("the brand constructor is not on the production surface", () => {
    const moduleExports = require("../../../utils/identity/directoryDiff");
    expect(moduleExports.completedEnumeration).toBeUndefined();
    expect(typeof moduleExports.__testHelpers__.completedEnumeration).toBe("function");
  });
});

describe("#134 R6: an interrupted run converges on re-run", () => {
  test("RF-4: the outstanding work COMPLETES on the second run, with no duplicates", async () => {
    // "No duplicates" alone is satisfied by a reconciler that skips everything on
    // the second run and leaves the sync permanently half-applied. So this asserts
    // the interrupted work actually lands.
    const dept = group("rf4-dept");
    const people = [
      principal("rf4-one", { groupExternalIds: [dept.externalId] }),
      principal("rf4-two", { groupExternalIds: [dept.externalId] }),
      principal("rf4-three", { groupExternalIds: [dept.externalId] }),
    ];
    const enumeration = completedEnumeration({ principals: people, groups: [dept] });
    const current = { users: [], groups: [], memberships: [] };

    // Interrupt: a db proxy that throws on the THIRD user creation, mid-apply.
    let userCreates = 0;
    const interrupting = new Proxy(prisma, {
      get(target, property) {
        if (property === "users") {
          return new Proxy(target.users, {
            get(userTarget, userProperty) {
              if (userProperty === "create") {
                return async (...args) => {
                  userCreates += 1;
                  if (userCreates === 3) throw new Error("interrupted mid-apply");
                  return userTarget.create(...args);
                };
              }
              return Reflect.get(userTarget, userProperty);
            },
          });
        }
        return Reflect.get(target, property);
      },
    });

    const checkpointsBefore = await prisma.directory_sync_checkpoints.count();
    await expect(
      applyDirectoryPlan({
        plan: diffDirectory({ enumeration, current }),
        actor: CORE_JOBS,
        provider: PROVIDER,
        db: interrupting,
      })
    ).rejects.toThrow("interrupted mid-apply");

    // RF-7: the checkpoint is written only after every write succeeded, so a crash
    // mid-apply leaves NO row claiming the run completed.
    expect(await prisma.directory_sync_checkpoints.count()).toBe(checkpointsBefore);

    const partialLinks = await prisma.identity_links.count({
      where: { subject: { in: people.map((p) => p.subject) } },
    });
    expect(partialLinks).toBe(2);

    // Re-run. The plan is re-derived from CURRENT state, which is what makes this
    // converge without run-id bookkeeping — bookkeeping would "skip" the unfinished
    // work and leave the sync half-applied forever.
    const links = await prisma.identity_links.findMany({
      where: { subject: { in: people.map((p) => p.subject) } },
      select: { subject: true, userId: true },
    });
    const rerunPlan = diffDirectory({
      enumeration,
      current: {
        users: links.map((l) => ({ subject: l.subject, suspended: false })),
        groups: [{ externalId: dept.externalId }],
        memberships: await currentMemberships(links, dept.externalId),
      },
    });

    const checkpoint = await applyDirectoryPlan({
      plan: rerunPlan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });
    expect(checkpoint.status).toBe("completed");

    // Converged: all three exist ONCE, and all three are in the department.
    const finalLinks = await prisma.identity_links.findMany({
      where: { subject: { in: people.map((p) => p.subject) } },
      select: { subject: true, userId: true },
    });
    expect(finalLinks).toHaveLength(3);
    expect(new Set(finalLinks.map((l) => l.subject)).size).toBe(3);

    const deptRow = await prisma.groups.findFirstOrThrow({
      where: { source: PROVIDER, externalId: dept.externalId },
    });
    const memberCount = await prisma.group_members.count({
      where: {
        group_id: deptRow.id,
        user_id: { in: finalLinks.map((l) => l.userId) },
      },
    });
    expect(memberCount).toBe(3);

    // And exactly one group row — the re-run must not have created a second.
    const deptRows = await prisma.groups.count({
      where: { source: PROVIDER, externalId: dept.externalId },
    });
    expect(deptRows).toBe(1);
  }, 180_000);

  test("RF-4b: the SAME plan applied twice is idempotent — the applier, not the diff", async () => {
    // RF-4 re-derives the plan from current state, so its second run has an EMPTY
    // create list and never reaches the applier's own idempotency. Two mutants
    // survived it: `upsertUser` and `upsertGroup` creating unconditionally. Both are
    // green under RF-4 and both corrupt this path.
    //
    // The case is real, not contrived. A run that crashes after writing but before
    // its checkpoint leaves state applied; the next run reads `current` and, if that
    // read raced the crash or came from a snapshot taken before it, produces a plan
    // that still says "create". Slice 1's "a replay produces an empty plan" is a
    // property of the DIFF given fresh state — it is not a property of the applier,
    // and the applier is what runs twice.
    const dept = group("rf4b-dept");
    const person = principal("rf4b-person", { groupExternalIds: [dept.externalId] });
    const plan = diffDirectory({
      enumeration: completedEnumeration({ principals: [person], groups: [dept] }),
      current: { users: [], groups: [], memberships: [] },
    });
    expect(plan.create).toHaveLength(1);
    expect(plan.createGroups).toHaveLength(1);
    expect(plan.addMembership).toHaveLength(1);

    const first = await applyDirectoryPlan({
      plan, actor: CORE_JOBS, provider: PROVIDER, db: prisma,
    });
    expect(first.usersCreated).toBe(1);
    expect(first.groupsCreated).toBe(1);

    // The SAME plan again — the object slice 1 produced, not a re-derived one.
    const second = await applyDirectoryPlan({
      plan, actor: CORE_JOBS, provider: PROVIDER, db: prisma,
    });

    // Converged, not duplicated. The counts are the visible half: a second run that
    // "created" the same person again is the bug, and it reports itself here.
    expect(second.status).toBe("completed");
    expect(second.usersCreated).toBe(0);
    expect(second.groupsCreated).toBe(0);

    const links = await prisma.identity_links.count({
      where: { provider: PROVIDER, subject: person.subject },
    });
    expect(links).toBe(1);
    const groups = await prisma.groups.count({
      where: { source: PROVIDER, externalId: dept.externalId },
    });
    expect(groups).toBe(1);

    // And no second user row wearing a suffixed username: `usernameCandidates`
    // resolves genuine collisions between DIFFERENT people, so a re-run falling
    // through to it would create a duplicate account that looks legitimate.
    const users = await prisma.users.count({
      where: { username: { startsWith: `rf4b-person-${dbSuffix}` } },
    });
    expect(users).toBe(1);
  }, 180_000);

  async function currentMemberships(links, groupExternalId) {
    const deptRow = await prisma.groups.findFirst({
      where: { source: PROVIDER, externalId: groupExternalId },
    });
    if (!deptRow) return [];
    const rows = await prisma.group_members.findMany({
      where: { group_id: deptRow.id, user_id: { in: links.map((l) => l.userId) } },
      select: { user_id: true },
    });
    const subjectByUserId = new Map(links.map((l) => [l.userId, l.subject]));
    return rows.map((r) => ({
      subject: subjectByUserId.get(r.user_id),
      groupExternalId,
    }));
  }
});

describe("#134 R5: a refused run and a no-op run are distinguishable", () => {
  test("RF-5: both write zero rows, and the checkpoint tells them apart", async () => {
    // Without the checkpoint these two runs are the same event, and the whole point
    // of refusing a misconfigured sync is that somebody notices.
    const dept = group("rf5-dept");
    const person = principal("rf5-person", { groupExternalIds: [dept.externalId] });

    // First: apply for real, so the second run has nothing to do.
    await applyDirectoryPlan({
      plan: diffDirectory({
        enumeration: completedEnumeration({ principals: [person], groups: [dept] }),
        current: { users: [], groups: [], memberships: [] },
      }),
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });

    const link = await prisma.identity_links.findUniqueOrThrow({
      where: { provider_subject: { provider: PROVIDER, subject: person.subject } },
    });

    // A NO-OP run: same snapshot, state already matches.
    const noopPlan = diffDirectory({
      enumeration: completedEnumeration({ principals: [person], groups: [dept] }),
      current: {
        users: [{ subject: person.subject, suspended: false }],
        groups: [{ externalId: dept.externalId }],
        memberships: [{ subject: person.subject, groupExternalId: dept.externalId }],
      },
    });
    expect(noopPlan.refused).toBe(false);
    expect(noopPlan.create).toEqual([]);
    expect(noopPlan.addMembership).toEqual([]);

    const before = await census();
    const noop = await applyDirectoryPlan({
      plan: noopPlan,
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });
    const afterNoop = await census();

    // A no-op writes nothing but the checkpoint — same zero-row footprint as RF-1.
    expect(afterNoop.users).toBe(before.users);
    expect(afterNoop.members).toBe(before.members);
    expect(afterNoop.versions).toBe(before.versions);

    // THE distinction. Both runs wrote nothing; only one is a problem.
    expect(noop.status).toBe("completed");
    expect(noop.refusedReason).toBeNull();

    const refused = await applyDirectoryPlan({
      plan: { ...noopPlan, refused: true, refusedReason: "scale guard: probe" },
      actor: CORE_JOBS,
      provider: PROVIDER,
      db: prisma,
    });
    expect(refused.status).toBe("refused");
    expect(refused.refusedReason).toBe("scale guard: probe");
    expect(refused.status).not.toBe(noop.status);

    // Belt and braces on the link, so the fixture is known to have applied.
    expect(link.userId).toBeTruthy();
  }, 180_000);

  test("the database itself refuses a refusal with no reason", async () => {
    // The CHECK constraint, not the application. This table is read to decide
    // whether the last sync refused, so a status written without a reason would be
    // a refusal nobody can act on — and the application is not the only writer.
    await expect(
      prisma.directory_sync_checkpoints.create({
        data: { provider: PROVIDER, status: "refused", startedAt: new Date() },
      })
    ).rejects.toThrow();

    await expect(
      prisma.directory_sync_checkpoints.create({
        data: {
          provider: PROVIDER,
          status: "completed",
          refusedReason: "a reason on a completed run is a contradiction",
          startedAt: new Date(),
        },
      })
    ).rejects.toThrow();

    await expect(
      prisma.directory_sync_checkpoints.create({
        data: { provider: PROVIDER, status: "refsued", startedAt: new Date() },
      })
    ).rejects.toThrow();
  }, 60_000);
});

describe("#134 R7: the actor is coreJobs, resolved the way the runtime resolves it", () => {
  test("RF-6: a coreJobs actor from identityStore.resolveActor drives addGroupMember", async () => {
    // N-3: resolved through the runtime path, not passed as a constant. Handing
    // SERVICE_PRINCIPALS.coreJobs straight in proves the repository accepts that
    // object; it does not prove the job runtime can still produce it. Those are
    // different claims, and only the second breaks when someone changes actor
    // resolution — `JobRuntime` wires `identityStore = { resolveActor: resolveActorRef }`.
    const resolved = await resolveActorRef({ type: "service", id: "core-jobs" });
    expect(resolved).toBeTruthy();
    expect(resolved.type).toBe("service");
    expect(resolved.id).toBe("core-jobs");

    const dept = group("rf6-dept");
    const person = principal("rf6-person", { groupExternalIds: [dept.externalId] });
    const checkpoint = await applyDirectoryPlan({
      plan: diffDirectory({
        enumeration: completedEnumeration({ principals: [person], groups: [dept] }),
        current: { users: [], groups: [], memberships: [] },
      }),
      actor: resolved,
      provider: PROVIDER,
      db: prisma,
    });

    expect(checkpoint.status).toBe("completed");
    expect(checkpoint.membershipsAdded).toBe(1);
  }, 120_000);

  test("RF-6 other direction: a DEACTIVATED actor cannot drive the apply", async () => {
    // The runtime refuses to run a job whose actor no longer may act
    // (`CoreJobWorker.claim` fails the job when resolveActor returns null). A
    // suspended user resolves to null, and an apply must not proceed on it — the
    // half that fails if someone makes the applier default its actor.
    const suspended = await prisma.users.create({
      data: {
        username: `rf6-suspended-${dbSuffix}`,
        password: "x",
        role: "admin",
        suspended: 1,
      },
    });
    const resolved = await resolveActorRef({ type: "user", id: suspended.id });
    expect(resolved).toBeNull();

    const dept = group("rf6-denied-dept");
    const person = principal("rf6-denied", { groupExternalIds: [dept.externalId] });
    const before = await census();

    await expect(
      applyDirectoryPlan({
        plan: diffDirectory({
          enumeration: completedEnumeration({ principals: [person], groups: [dept] }),
          current: { users: [], groups: [], memberships: [] },
        }),
        actor: resolved,
        provider: PROVIDER,
        db: prisma,
      })
    ).rejects.toThrow();

    // And it failed BEFORE writing anything — an applier that creates the users and
    // then discovers it has no actor has already done the damage.
    const after = await census();
    expect(after.users).toBe(before.users);
    expect(after.groups).toBe(before.groups);
    expect(after.checkpoints).toBe(before.checkpoints);
  }, 120_000);
});
