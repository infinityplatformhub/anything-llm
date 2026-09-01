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

  test("the Actor carries no user-row columns beyond the seam-02 shape", async () => {
    const db = memberDb([], {
      id: 5,
      username: "u",
      password: "hash",
      pfpFilename: "me.png",
      seen_recovery_codes: true,
      suspended: 0,
    });
    const actor = await resolveActorRef({ type: "user", id: "5" }, { db });
    for (const leaked of ["password", "pfpFilename", "seen_recovery_codes", "username"]) {
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

  test("an unknown actorRef yields null — the worker never runs an actorless job", async () => {
    expect(await resolveActorRef(null, { db: memberDb([]) })).toBeNull();
    expect(await resolveActorRef({ type: "user" }, { db: memberDb([]) })).toBeNull();
  });
});
