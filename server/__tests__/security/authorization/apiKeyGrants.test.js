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

const { SystemSettings } = require("../../../models/systemSettings");
const { resolveActor } = require("../../../utils/authorization/actorResolver");

const res = (locals) => ({ locals });
// QA-2 FINDING-1: single-user is confirmed against `users.count() === 0`, not taken from
// the setting alone — so a fixture must say which deployment shape it is modelling.
// Default: a populated (multi-user) deployment.
const keyDb = (apiKey, workspaceIds = [], userCount = 3, creator = { suspended: 0 }) => ({
  api_keys: { findUnique: async () => apiKey },
  // S12 (#136): the resolver reads the creator's row to refuse a SUSPENDED one, so
  // a stub that omits `findUnique` is now a stub that denies — correctly, since an
  // unreadable users table must fail closed. These fixtures model an ACTIVE creator;
  // the suspended and missing cases have their own tests in offboardUser.test.js.
  users: { count: async () => userCount, findUnique: async () => creator },
  workspace_users: {
    findMany: async () => workspaceIds.map((id) => ({ workspace_id: id })),
  },
});
const context = (over = {}) => ({
  keyId: 7,
  keyPrefix: "apw-key-x",
  scopes: ["document.read"],
  workspaceId: null,
  // issue 45: keyKind is required — the resolver refuses a context that does not say which
  // credential table its id came from.
  keyKind: "api-key",
  ...over,
});

describe("T-4b B-1: a key's grants come from its creator, not from the key principal", () => {
  // Multi-user is the default here: it is the mode where a null creator means "orphan".
  // The single-user fallback is exercised explicitly by the test that names it.
  beforeEach(() => SystemSettings.isMultiUserMode.mockResolvedValue(true));

  test("the Actor keeps api-key provenance but resolves grants as the creator", async () => {
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    // provenance for audit is unchanged — auth.key_used still names the key
    expect(actor).toMatchObject({ type: "service", id: "api-key:7", scopedKeyId: "7" });
    // and the principal the engine evaluates grants against is the creator
    expect(actor.grantPrincipal).toEqual({ type: "user", id: "5" });
  });

  test("in MULTI-user mode a key whose creator is null is an orphan and can only deny", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    const db = keyDb({ id: 7, createdBy: null });
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toBeNull();
  });

  test("in SINGLE-user mode a creatorless key falls back to the single-user principal", async () => {
    // endpoints/system.js:1073 mints keys with ApiKey.create(null, name) and refuses to
    // run in multi-user mode: in a single-user deployment there are NO user rows, so every
    // key ever issued there has a null creator. Denying them takes the whole /v1 surface
    // offline on upgrade, for the deployments least able to diagnose it.
    // QA-2 FINDING-1: and "single-user" means no user rows exist, not merely that the
    // setting says so — singleUserFallback.test.js covers the populated case.
    SystemSettings.isMultiUserMode.mockResolvedValue(false);
    const db = keyDb({ id: 7, createdBy: null }, [], 0);
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toEqual({ type: "service", id: "single-user" });
  });

  test("a key whose creator row is gone carries no grant principal", async () => {
    SystemSettings.isMultiUserMode.mockResolvedValue(true);
    const db = keyDb(null);
    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });
    expect(actor.grantPrincipal).toBeNull();
  });

  test("the single-user fallback is never reachable in multi-user mode", async () => {
    // The fallback is a compatibility path, not a bypass: if isMultiUserMode is ever
    // unreadable it fails toward multi-user (deny), the same as every other branch.
    SystemSettings.isMultiUserMode.mockRejectedValue(new Error("db down"));
    const db = keyDb({ id: 7, createdBy: null });
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

  test("a browser-extension key is NOT looked up in api_keys — different table, colliding ids", async () => {
    // validBrowserExtensionApiKey writes apiKeyContext too, but its keyId comes from
    // `browser_extension_api_keys`, a separate table with its own id sequence. Resolving
    // it against `api_keys` hands extension key 7 the grants of API key 7's creator — an
    // unrelated user. The extension already resolves its own user onto locals.user, and
    // that is the identity its grants must come from.
    const db = {
      api_keys: {
        findUnique: async () => {
          throw new Error("an extension key must not be resolved against api_keys");
        },
      },
      workspace_users: { findMany: async () => [{ workspace_id: 3 }] },
    };
    const actor = await resolveActor(
      {},
      res({
        apiKeyContext: context({ keyKind: "browser-extension" }),
        user: { id: 5, suspended: 0 },
      }),
      { db }
    );
    // it resolves as the extension's user, not as a service principal borrowing grants
    expect(actor).toMatchObject({ type: "user", id: "5" });
    expect(actor.workspaceIds).toEqual(["3"]);
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
