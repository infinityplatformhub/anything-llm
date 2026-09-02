// T-4b (#29), QA-2 FINDING-1 — the single-user fallback must not be reachable in a
// deployment that has users.
//
// `isMultiUserModeSafe()` wraps `SystemSettings.isMultiUserMode()` in a try/catch that
// claims to fail toward the restrictive mode. That catch is DEAD: isMultiUserMode
// (systemSettings.js:747) catches its own error and returns `false`. So "the database is
// unreachable" and "the multi_user_mode row is missing" both arrive at the resolver as a
// confident "this is a single-user deployment", and an anonymous request with no
// credential at all resolves to SINGLE_USER_ACTOR — which holds the seeded super_admin
// grant, i.e. workspace.delete on every workspace.
//
// The third case needs no outage to reach: a partial restore or a migration that drops the
// settings row is enough.
//
// Fix under test: the setting alone is not sufficient evidence. Single-user is confirmed
// against `users.count() === 0`, so a deployment with real users can never fall into it,
// however the setting reads; and an unreadable/absent setting is treated as multi-user.
// RED on 4c32bce3: every case below resolves to the single-user service principal.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn(), get: jest.fn() },
}));

const { SystemSettings } = require("../../../models/systemSettings");
const { resolveActor } = require("../../../utils/authorization/actorResolver");

const res = (locals = {}) => ({ locals });
/** A deployment that HAS users — i.e. genuinely multi-user, whatever the setting says. */
const populatedDb = (userCount = 3) => ({
  users: { count: async () => userCount },
  workspace_users: { findMany: async () => [] },
  api_keys: { findUnique: async () => ({ createdBy: null }) },
});

beforeEach(() => jest.resetAllMocks());

describe("QA-2 FINDING-1: single-user is confirmed by evidence, not by a setting alone", () => {
  test("an unreadable settings table does NOT make a populated deployment single-user", async () => {
    // isMultiUserMode swallows its own error and answers false — the resolver must not
    // take that as proof of single-user.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const actor = await resolveActor({}, res({}), { db: populatedDb() });
    expect(actor).toBeNull();
  });

  test("a missing multi_user_mode row does NOT make a populated deployment single-user", async () => {
    // Same false, different cause: a partial restore or a migration that dropped the row.
    // No outage required, which is what makes this the realistic one.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const actor = await resolveActor({}, res({}), { db: populatedDb(1) });
    expect(actor).toBeNull();
  });

  test("a thrown settings error is treated as multi-user, not as single-user", async () => {
    SystemSettings.isMultiUserMode.mockRejectedValue(new Error("db down"));
    const actor = await resolveActor({}, res({}), { db: populatedDb() });
    expect(actor).toBeNull();
  });

  test("an orphan API key gets no grant principal in a populated deployment", async () => {
    // The B-1 compatibility fallback (createdBy null -> single-user principal) must be
    // gated by the same evidence: otherwise a key with no creator borrows super_admin.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const actor = await resolveActor(
      {},
      res({ apiKeyContext: { keyId: 7, keyPrefix: "apw-key-x", scopes: ["*"], workspaceId: null, keyKind: "api-key" } }),
      { db: populatedDb() }
    );
    expect(actor.grantPrincipal).toBeNull();
  });

  test("an unreadable users table denies too — absence of evidence is not evidence", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const db = {
      users: {
        count: async () => {
          throw new Error("db down");
        },
      },
      workspace_users: { findMany: async () => [] },
    };
    expect(await resolveActor({}, res({}), { db })).toBeNull();
  });

  test("both reads failing at once still denies — the bug must not move to the second read", async () => {
    // Techlead: if the users.count() catch returned 0 rather than denying, this fix would
    // simply relocate FINDING-1 from the settings read to the membership read.
    SystemSettings.isMultiUserMode.mockRejectedValue(new Error("db down"));
    const db = {
      users: {
        count: async () => {
          throw new Error("db down");
        },
      },
      workspace_users: { findMany: async () => [] },
    };
    expect(await resolveActor({}, res({}), { db })).toBeNull();
  });

  test("mid-onboarding (admin created, mode not yet flipped) denies rather than granting", async () => {
    // endpoints/system.js creates the first User BEFORE writing multi_user_mode=true.
    // In that window the setting still says single-user while a user row exists, so this
    // resolver returns null and the request is denied. That is the correct direction:
    // the alternative is handing super_admin to an anonymous caller for the length of the
    // window. See the note at isConfirmedSingleUser about the ordering of those two lines.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const db = {
      users: { count: async () => 1 },
      workspace_users: { findMany: async () => [] },
    };
    expect(await resolveActor({}, res({}), { db })).toBeNull();
  });

  test("a genuinely empty deployment still resolves the single-user principal (R5)", async () => {
    // The fallback exists for a reason: single-user deployments have no user rows at all,
    // and R5 says no code path may skip checks — the principal is explicit and evaluated.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const db = {
      users: { count: async () => 0 },
      workspace_users: { findMany: async () => [] },
    };
    const actor = await resolveActor({}, res({}), { db });
    expect(actor).toEqual({ type: "service", id: "single-user", orgId: 1 });
  });

  test("an orphan key in a genuinely empty deployment keeps its compatibility fallback", async () => {
    // endpoints/system.js:1073 mints keys with createdBy null and refuses to run in
    // multi-user mode, so every key in such a deployment has no creator.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const db = {
      users: { count: async () => 0 },
      workspace_users: { findMany: async () => [] },
      api_keys: { findUnique: async () => ({ createdBy: null }) },
    };
    const actor = await resolveActor(
      {},
      res({ apiKeyContext: { keyId: 7, keyPrefix: "apw-key-x", scopes: ["*"], workspaceId: null, keyKind: "api-key" } }),
      { db }
    );
    expect(actor.grantPrincipal).toEqual({ type: "service", id: "single-user" });
  });

  test("multi-user mode is unaffected — an anonymous request was already denied", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    const db = {
      users: {
        count: async () => {
          throw new Error("users must not be counted when the mode is already multi-user");
        },
      },
      workspace_users: { findMany: async () => [] },
    };
    expect(await resolveActor({}, res({}), { db })).toBeNull();
  });
});

describe("issue 30 follow-up: resolveActor refuses a forgotten response", () => {
  // Techlead-1 NIT-1. `response?.locals ?? {}` made the second argument optional in effect:
  // omit it and every branch misses, so the caller silently receives SINGLE_USER_ACTOR —
  // the widest actor in the system. Worse than a plain crash, because it hands back a
  // valid-looking Actor rather than an error, so nothing downstream can tell.
  //
  // This is the shape #30 closed three times over: an optional security argument that fails
  // toward MORE access. The fix is that it now throws.

  test("calling with one argument throws rather than resolving to single-user", async () => {
    await expect(resolveActor({})).rejects.toThrow(/requires a response/i);
  });

  test("an EXPLICIT null response is still allowed", async () => {
    // The distinction that makes `arguments.length` the right check rather than a null
    // test: a caller passing null is stating it has no response, which the branches already
    // handle. Only FORGETTING the argument is the bug, and only that is refused.
    const db = {
      users: { count: async () => 0, findFirst: async () => null },
      system_settings: { findFirst: async () => null },
      workspace_users: { findMany: async () => [] },
    };
    await expect(resolveActor({}, null, { db })).resolves.not.toThrow;
  });
});
