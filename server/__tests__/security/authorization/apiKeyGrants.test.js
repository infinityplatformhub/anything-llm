// T-4b (#29) B-1 unit tests — a scoped API key's effective permission is
// grants(createdBy) ∩ scopes(key).
//
// `resolveActor` mints the principal `api-key:<id>`, and no grant row ever names that
// principal, so the engine answers `no_grants` for every /v1 route the moment W-8 starts
// asking. The key is not an identity that can hold policy — it is a bearer credential for
// its creator, narrowed by its own scope list. The Actor keeps the `api-key:` id for audit
// provenance and carries the creator as the principal grants resolve against.
//
// `createdBy` is nullable (schema.prisma:20). A key with no creator has no grants to
// intersect, so it denies — loudly at boot, never silently at request time.
// RED on `approof/main 54db4028`: the resolver reports no grant principal at all.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const { resolveActor } = require("../../../utils/authorization/actorResolver");

const res = (locals) => ({ locals });
const keyDb = (apiKey, workspaceIds = []) => ({
  api_keys: { findUnique: async () => apiKey },
  workspace_users: {
    findMany: async () => workspaceIds.map((id) => ({ workspace_id: id })),
  },
});
const context = (over = {}) => ({
  keyId: 7,
  keyPrefix: "apw-key-x",
  scopes: ["document.read"],
  workspaceId: null,
  ...over,
});

describe("T-4b B-1: a key's grants come from its creator, not from the key principal", () => {
  test("the Actor keeps api-key provenance but resolves grants as the creator", async () => {
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    // provenance for audit is unchanged — auth.key_used still names the key
    expect(actor).toMatchObject({ type: "service", id: "api-key:7", scopedKeyId: "7" });
    // and the principal the engine evaluates grants against is the creator
    expect(actor.grantPrincipal).toEqual({ type: "user", id: "5" });
  });

  test("a key whose creator is null carries no grant principal — it can only deny", async () => {
    const db = keyDb({ id: 7, createdBy: null });
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toBeNull();
  });

  test("a key whose creator row is gone carries no grant principal", async () => {
    const db = keyDb(null);
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toBeNull();
  });

  test("the creator's workspace memberships become the key's scope when the key is unbound", async () => {
    // An unbound key inherits its creator's reach; a workspace-bound key is narrower and
    // keeps its binding, never widening to everything the creator can see.
    const unbound = await resolveActor(
      {},
      res({ apiKeyContext: context() }),
      { db: keyDb({ id: 7, createdBy: 5 }, [3, 9]) }
    );
    expect(unbound.workspaceIds).toEqual(["3", "9"]);

    const bound = await resolveActor(
      {},
      res({ apiKeyContext: context({ workspaceId: "3" }) }),
      { db: keyDb({ id: 7, createdBy: 5 }, [3, 9]) }
    );
    expect(bound.workspaceIds).toEqual(["3"]);
  });

  test("the key's own scopes stay on the Actor so the intersection has both halves", async () => {
    const db = keyDb({ id: 7, createdBy: 5 });
    const actor = await resolveActor(
      {},
      res({ apiKeyContext: context({ scopes: ["document.read", "chat.write"] }) }),
      { db }
    );
    expect(actor.attributes.scopes).toEqual(["document.read", "chat.write"]);
  });

  test("a revoked or expired key never reaches the creator lookup", async () => {
    const db = {
      api_keys: {
        findUnique: async () => {
          throw new Error("a dead key must not be resolved this far");
        },
      },
      workspace_users: { findMany: async () => [] },
    };
    expect(
      await resolveActor({}, res({ apiKeyContext: context({ revokedAt: new Date() }) }), { db })
    ).toBeNull();
    expect(
      await resolveActor(
        {},
        res({ apiKeyContext: context({ expiresAt: new Date(Date.now() - 60_000) }) }),
        { db }
      )
    ).toBeNull();
  });

  test("an unreadable api_keys table denies rather than resolving an ungranted actor", async () => {
    const db = {
      api_keys: {
        findUnique: async () => {
          throw new Error("db down");
        },
      },
      workspace_users: { findMany: async () => [] },
    };
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toBeNull();
  });
});
