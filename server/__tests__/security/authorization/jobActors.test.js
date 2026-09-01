// T-4b (#29) W-11 — every job and channel entry point runs as a NAMED principal.
//
// `jobs/*.js` are standalone scripts that resolve workspaces, chats and documents with no
// actor at all. A null actor is not a safe default: the engine denies it, which is correct
// but would break the jobs silently rather than loudly, so each site must CHOOSE its
// principal — the originating user for per-user work, `core-jobs` for system work.
// RED on main: `jobActor` does not exist.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const {
  jobActor,
  SERVICE_PRINCIPALS,
} = require("../../../utils/authorization/actorResolver");

const memberDb = (workspaceIds, user = { id: 5, suspended: 0 }) => ({
  workspace_users: {
    findMany: async () => workspaceIds.map((id) => ({ workspace_id: id })),
  },
  users: { findUnique: async () => user },
});

describe("T-4b W-11: jobs and channels resolve a named principal, never null", () => {
  test("system work runs as core-jobs, a real principal the engine evaluates", async () => {
    const actor = await jobActor({ db: memberDb([]) });
    expect(actor).toMatchObject(SERVICE_PRINCIPALS.coreJobs);
    expect(actor.type).toBe("service");
  });

  test("per-user work runs as that user, with that user's real scope", async () => {
    // extract-memories reads one (user, workspace) pair at a time; running it as
    // core-jobs would summarize chats the user themself could no longer read.
    const actor = await jobActor({ userId: 5, db: memberDb([3, 9]) });
    expect(actor).toMatchObject({ type: "user", id: "5" });
    expect(actor.workspaceIds).toEqual(["3", "9"]);
  });

  test("a suspended or deleted originating user does NOT fall back to core-jobs", async () => {
    // The dangerous shape: falling back to a service principal on a failed lookup would
    // silently escalate a suspended user's queued work to system privileges.
    const suspended = await jobActor({ userId: 5, db: memberDb([], { id: 5, suspended: 1 }) });
    expect(suspended).toBeNull();
    const missing = await jobActor({ userId: 5, db: memberDb([], null) });
    expect(missing).toBeNull();
  });

  test("core-jobs carries no workspace scope of its own — it holds grants, not membership", async () => {
    const actor = await jobActor({ db: memberDb([1, 2, 3]) });
    expect(actor.workspaceIds ?? []).toEqual([]);
  });
});
