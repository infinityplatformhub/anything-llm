// T-4b (#29) W-5 unit tests — `utils/jobs/ActorIdentityStore` is a SECOND Actor
// construction site. It spreads the whole user row into the Actor, hardcodes
// `workspaceIds: []` (now wrong: T-3 made the HTTP resolver derive membership, so the
// same user reads documents over HTTP and reads nothing in a job), and never stamps
// `impersonatedBy`. These lock the merged shape before the class is deleted.
// RED on `approof/main 01e97fd7`: `resolveActorRef` does not exist yet.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const { SystemSettings } = require("../../../models/systemSettings");
const {
  resolveActor,
  resolveActorRef,
} = require("../../../utils/authorization/actorResolver");

const res = (locals) => ({ locals });
const memberDb = (workspaceIds, user = { id: 5, suspended: 0 }) => ({
  workspace_users: {
    findMany: async () => workspaceIds.map((id) => ({ workspace_id: id })),
  },
  users: { findUnique: async () => user },
});

describe("T-4b W-5: resolveActorRef — jobs build Actors in the resolver too", () => {
  afterEach(() => jest.resetAllMocks());

  test("a job acting as a user gets the SAME workspaceIds that user gets over HTTP", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    const db = memberDb([3, 9]);
    const overHttp = await resolveActor({}, res({ user: { id: 5, suspended: 0 } }), { db });
    const inJob = await resolveActorRef({ type: "user", id: "5" }, { db });
    expect(inJob.workspaceIds).toEqual(overHttp.workspaceIds);
    expect(inJob.workspaceIds).toEqual(["3", "9"]);
  });

  test("the Actor carries ONLY seam-02 keys — the whole user row is denied by allowlist", async () => {
    // Asserted as an allowlist, not a list of known-bad names: ActorIdentityStore spread
    // `...user`, so every column the users table grows would have joined the object the
    // engine reads. A denylist passes the day someone adds column 12 (QA-1 baseline).
    const ACTOR_KEYS = ["type", "id", "orgId", "workspaceIds", "impersonatedBy"];
    const db = memberDb([3], {
      id: 5,
      username: "u",
      password: "hash",
      pfpFilename: "me.png",
      seen_recovery_codes: true,
      web_push_subscription_config: "{}",
      role: "admin",
      suspended: 0,
      dailyMessageLimit: 10,
      bio: "x",
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    });
    const actor = await resolveActorRef({ type: "user", id: "5" }, { db });
    expect(Object.keys(actor).sort()).toEqual([...ACTOR_KEYS].sort());
    // named explicitly so a failure reads as the leak it is
    for (const leaked of ["password", "seen_recovery_codes", "web_push_subscription_config", "role"]) {
      expect(actor).not.toHaveProperty(leaked);
    }
  });

  test("a suspended user yields null so the worker fails the job closed", async () => {
    const db = memberDb([], { id: 5, suspended: 1 });
    expect(await resolveActorRef({ type: "user", id: "5" }, { db })).toBeNull();
  });

  test("a missing user yields null rather than an actor with no grants", async () => {
    const db = memberDb([], null);
    expect(await resolveActorRef({ type: "user", id: "5" }, { db })).toBeNull();
  });

  test("impersonatedBy on the job's actorRef survives into the Actor", async () => {
    // ActorIdentityStore never stamped it, so an impersonated session could enqueue a
    // mutating job and CoreJobWorker's denyImpersonatedMutation had nothing to check.
    const db = memberDb([]);
    const actor = await resolveActorRef({ type: "user", id: "5", impersonatedBy: 1 }, { db });
    expect(actor.impersonatedBy).toEqual({ type: "user", id: "1" });
  });

  test("a service actorRef passes through without a user or membership read", async () => {
    const db = {
      workspace_users: {
        findMany: async () => {
          throw new Error("membership must not be read for a service principal");
        },
      },
      users: {
        findUnique: async () => {
          throw new Error("users must not be read for a service principal");
        },
      },
    };
    const actor = await resolveActorRef({ type: "service", id: "core-jobs", orgId: 1 }, { db });
    expect(actor).toMatchObject({ type: "service", id: "core-jobs", orgId: 1 });
  });

  test("orgId is derived, never taken from the persisted job row", async () => {
    // orgId decides which org's policy rows are read, so a written row choosing its own
    // tenant would be a cross-tenant read waiting to happen (QA-1).
    const asUser = await resolveActorRef({ type: "user", id: "5", orgId: 42 }, { db: memberDb([]) });
    expect(asUser.orgId).toBe(1);
    const asService = await resolveActorRef(
      { type: "service", id: "core-jobs", orgId: 42 },
      { db: memberDb([]) }
    );
    expect(asService.orgId).toBe(1);
  });

  test("an unknown actorRef yields null — the worker never runs an actorless job", async () => {
    expect(await resolveActorRef(null, { db: memberDb([]) })).toBeNull();
    expect(await resolveActorRef({ type: "user" }, { db: memberDb([]) })).toBeNull();
  });
});

describe("T-4b W-5: the resolved Actor is authoritative over the persisted job row", () => {
  const { CoreJobWorker } = require("../../../utils/jobs/CoreJobWorker");

  test("fields on the stored job.actor never override the freshly resolved scope", async () => {
    // CoreJobWorker.claim spread the persisted row OVER the resolved Actor, so anything
    // that can write a job row (a compromised enqueue path, a stale row written before a
    // revoke) chose its own workspaceIds and impersonatedBy at run time. The row names
    // WHO the job runs as; what that principal may do is resolved fresh, every claim.
    const storedActor = {
      type: "user",
      id: "5",
      workspaceIds: ["999"],
      impersonatedBy: undefined,
      orgId: 42,
    };
    const queue = {
      claim: async () => [{ jobId: "1", actor: storedActor, payload: { version: 1 } }],
      fail: jest.fn(),
    };
    const worker = new CoreJobWorker({
      queue,
      identityStore: {
        resolveActor: async () => ({
          type: "user",
          id: "5",
          orgId: 1,
          workspaceIds: ["3"],
          impersonatedBy: { type: "user", id: "1" },
        }),
      },
      handlers: {},
    });
    const [job] = await worker.claim({ workerId: "w" });
    expect(job.actor.workspaceIds).toEqual(["3"]);
    expect(job.actor.orgId).toBe(1);
    expect(job.actor.impersonatedBy).toEqual({ type: "user", id: "1" });
  });

  test("a null resolution fails the job closed rather than running it unresolved", async () => {
    const queue = {
      claim: async () => [{ jobId: "1", actor: { type: "user", id: "5" }, payload: { version: 1 } }],
      fail: jest.fn(),
    };
    const worker = new CoreJobWorker({
      queue,
      identityStore: { resolveActor: async () => null },
      handlers: {},
    });
    expect(await worker.claim({ workerId: "w" })).toEqual([]);
    expect(queue.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ retryable: false }),
      })
    );
  });
});
