// T-2 (#20) unit tests — actorResolver against mocked response.locals per ingress row
// (p0-5-t2-actor-resolver.md). No DB: SystemSettings.isMultiUserMode is stubbed per case.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const { SystemSettings } = require("../../../models/systemSettings");
const { resolveActor } = require("../../../utils/authorization/actorResolver");

const res = (locals) => ({ locals });

describe("actorResolver — the only Actor construction point", () => {
  afterEach(() => jest.resetAllMocks());

  test("row 1/4/5/7: locals.user becomes a user Actor with provenance", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    const actor = await resolveActor({}, res({ user: { id: 5, suspended: 0 } }));
    expect(actor).toMatchObject({ type: "user", id: "5", orgId: 1 });
    expect(actor.impersonatedBy).toBeUndefined();
  });

  test("suspended user resolves to null — no actor, engine denies", async () => {
    const actor = await resolveActor({}, res({ user: { id: 5, suspended: 1 } }));
    expect(actor).toBeNull();
  });

  test("impersonatedBy is stamped as immutable provenance", async () => {
    const actor = await resolveActor({}, res({ user: { id: 5, suspended: 0 }, impersonatedBy: 1 }));
    expect(actor.impersonatedBy).toEqual({ type: "user", id: "1" });
  });

  test("row 3: PR-3 apiKeyContext (raw) becomes the service Actor — revoked key is null", async () => {
    const base = { keyId: 7, keyPrefix: "apw-key-x", scopes: ["workspace.read"], workspaceId: 3, keyKind: "api-key" };
    const actor = await resolveActor({}, res({ apiKeyContext: { ...base } }));
    expect(actor).toMatchObject({
      type: "service",
      id: "api-key:7",
      orgId: 1,
      // T-4b: stringified like every other resolver path — a bound key's workspace id
      // ends up in a filter's workspaceIds, which seam 07 types as string[].
      workspaceIds: ["3"],
      scopedKeyId: "7",
    });
    expect(actor.attributes.scopes).toEqual(["workspace.read"]);
    const revoked = await resolveActor({}, res({ apiKeyContext: { ...base, revokedAt: new Date() } }));
    expect(revoked).toBeNull();
  });

  test("F-20d: an expired key yields no actor — lifecycle is checked in full, not half", async () => {
    const base = { keyId: 8, keyPrefix: "apw-key-y", scopes: ["workspace.read"], workspaceId: 3, keyKind: "api-key" };
    const expired = await resolveActor(
      {},
      res({ apiKeyContext: { ...base, expiresAt: new Date(Date.now() - 60_000) } })
    );
    expect(expired).toBeNull();
    const live = await resolveActor(
      {},
      res({ apiKeyContext: { ...base, expiresAt: new Date(Date.now() + 60_000) } })
    );
    expect(live).toMatchObject({ type: "service", id: "api-key:8" });
  });

  test("row 6: embed config is a REAL actor — anonymous but never null", async () => {
    const actor = await resolveActor({}, res({ embedConfig: { uuid: "emb-1", workspace: { id: 4 } } }));
    expect(actor).toMatchObject({ type: "embed", id: "emb-1", workspaceIds: ["4"] });
  });

  test("row 2 / R5: single-user mode yields the explicit service principal — no skip path", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    // T-4b tightened this: single-user now also requires that no user rows
    // exist, so an instance mid-migration to multi-user cannot resolve to the
    // super_admin service principal. The test predates that and mocked only
    // isMultiUserMode, leaving users.count undefined.
    const actor = await resolveActor({}, res({}), {
      db: { users: { count: async () => 0 } },
    });
    expect(actor).toEqual({ type: "service", id: "single-user", orgId: 1 });
  });

  test("rows 8-11: agents with null user, jobs, telegram, unauthenticated → null (deny)", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    expect(await resolveActor({}, res({}))).toBeNull();
    expect(await resolveActor({}, res({ apiKeyContext: undefined, user: null }))).toBeNull();
  });

  test("multi-user detection failure fails toward the restrictive mode", async () => {
    SystemSettings.isMultiUserMode.mockRejectedValue(new Error("db down"));
    expect(await resolveActor({}, res({}))).toBeNull();
  });
});
