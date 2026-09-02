// issue 45 (QA-2 T-4b #4, latent) — `apiKeyContext.keyKind` is REQUIRED, and an untagged
// context fails closed instead of defaulting into the `api_keys` branch.
//
// Today the resolver decides by exclusion: anything that is not tagged
// "browser-extension" is looked up in `api_keys`. That reads as safe because there are
// exactly two ingress paths and both behave. It is safe only by accident:
//
//   - `browser_extension_api_keys` and `api_keys` have independent id sequences, so an id
//     that lands in the wrong branch resolves to a real, unrelated row. Extension key 7
//     inherits API key 7's creator's grants. Nothing errors; the request is authorized as
//     someone else. This is the #33 / T-4b cross-credential class.
//   - The tag is what prevents it, and the tag is set by the ingress, not by the type
//     system. A third ingress that writes an apiKeyContext and forgets `keyKind` inherits
//     the collision silently — no throw, no log, a green test suite.
//
// So the default must invert: unknown provenance is a contract violation, not an
// assumption. A caller that cannot say which credential table its id came from has not
// given the resolver enough to resolve safely, and guessing is exactly the bug.
//
// RED on approof/main 46b3f1f6: the first two cases resolve to a service Actor holding
// api_keys grants instead of throwing.

jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: { isMultiUserMode: jest.fn() },
}));

const { SystemSettings } = require("../../../models/systemSettings");
const { resolveActor } = require("../../../utils/authorization/actorResolver");
const {
  AuthorizationContractError,
} = require("../../../utils/authorization/errors");

const res = (locals) => ({ locals });
const keyDb = (apiKey, workspaceIds = [], userCount = 3) => ({
  api_keys: { findUnique: async () => apiKey },
  // S12 (#136): the resolver reads the key creator's row to refuse a SUSPENDED
  // one, and an unreadable users table denies. Active creator by default.
  users: { count: async () => userCount, findUnique: async () => ({ suspended: 0 }) },
  workspace_users: {
    findMany: async () => workspaceIds.map((id) => ({ workspace_id: id })),
  },
});
const context = (over = {}) => ({
  keyId: 7,
  keyPrefix: "apw-key-x",
  scopes: ["document.read"],
  workspaceId: null,
  keyKind: "api-key",
  ...over,
});

describe("issue 45: an apiKeyContext must declare which credential table it came from", () => {
  beforeEach(() => SystemSettings.isMultiUserMode.mockResolvedValue(true));

  test("a context with NO keyKind throws instead of resolving as an api_keys credential", async () => {
    // The latent bug in one line: this context is indistinguishable from a legitimate
    // api-key context, and today it resolves as one.
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);
    const { keyKind, ...untagged } = context();

    await expect(
      resolveActor({}, res({ apiKeyContext: untagged }), { db })
    ).rejects.toThrow(AuthorizationContractError);
  });

  test("an UNKNOWN keyKind throws rather than falling through to any branch", async () => {
    // A future credential table ("service-account", a typo, anything) must not inherit
    // api_keys grants by virtue of not being the string "browser-extension".
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    await expect(
      resolveActor({}, res({ apiKeyContext: context({ keyKind: "service-account" }) }), {
        db,
      })
    ).rejects.toThrow(AuthorizationContractError);
  });

  test("the throw names the offending value, so a bad ingress is findable", async () => {
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    await expect(
      resolveActor({}, res({ apiKeyContext: context({ keyKind: "nonsense" }) }), { db })
    ).rejects.toThrow(/nonsense/);
  });

  test("keyKind must be the exact string — no case folding, no trimming", async () => {
    // Normalizing here would be a second way to be almost-right about provenance.
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    for (const bad of ["API-KEY", " api-key", "api_key", "Browser-Extension"]) {
      await expect(
        resolveActor({}, res({ apiKeyContext: context({ keyKind: bad }) }), { db })
      ).rejects.toThrow(AuthorizationContractError);
    }
  });

  test("a non-string keyKind throws too", async () => {
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    for (const bad of [null, 1, true, {}, ["api-key"]]) {
      await expect(
        resolveActor({}, res({ apiKeyContext: context({ keyKind: bad }) }), { db })
      ).rejects.toThrow(AuthorizationContractError);
    }
  });

  test("the failure is a CONTRACT error, not a denial — it is a bug, not a decision", async () => {
    // Returning null would deny the request, which looks correct and hides the wiring
    // fault forever. A throw surfaces it at the first request the broken ingress serves.
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);
    const { keyKind, ...untagged } = context();

    const error = await resolveActor({}, res({ apiKeyContext: untagged }), { db }).catch(
      (e) => e
    );

    expect(error).toBeInstanceOf(AuthorizationContractError);
  });

  test("no keyKind check happens when there is no apiKeyContext at all", async () => {
    // Absence of a key context is not a contract violation — it is a request that simply
    // did not come through a key ingress. It must still resolve normally.
    const db = keyDb(null, [], 3);

    const actor = await resolveActor({}, res({ apiKeyContext: undefined, user: null }), {
      db,
    });

    expect(actor).toBeNull();
  });
});

describe("issue 45: both real ingress paths still resolve", () => {
  beforeEach(() => SystemSettings.isMultiUserMode.mockResolvedValue(true));

  test('keyKind "api-key" resolves against api_keys, as before', async () => {
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    const actor = await resolveActor({}, res({ apiKeyContext: context() }), { db });

    expect(actor).toMatchObject({ type: "service", id: "api-key:7", scopedKeyId: "7" });
    expect(actor.grantPrincipal).toEqual({ type: "user", id: "5" });
  });

  test('keyKind "browser-extension" still falls through to the user branch', async () => {
    // Unchanged behaviour from T-4b: the extension resolves its own user onto locals.user,
    // and its grants belong to that user, not to whatever api_keys row shares its id.
    const db = keyDb({ id: 7, createdBy: 5 }, [3]);

    const actor = await resolveActor(
      {},
      res({
        apiKeyContext: context({ keyKind: "browser-extension" }),
        user: { id: 42, role: "default" },
      }),
      { db }
    );

    expect(actor.type).toBe("user");
    expect(actor.id).toBe("42");
    // and crucially it did NOT pick up api_keys row 7's creator
    expect(actor.id).not.toBe("api-key:7");
  });

  test("an extension context does not need api_keys to be reachable at all", async () => {
    // Proof the branch is taken before any api_keys lookup: this db throws if touched.
    const db = {
      api_keys: {
        findUnique: async () => {
          throw new Error("api_keys must not be read for a browser-extension context");
        },
      },
      users: { count: async () => 3, findUnique: async () => ({ suspended: 0 }) },
      workspace_users: { findMany: async () => [] },
    };

    const actor = await resolveActor(
      {},
      res({
        apiKeyContext: context({ keyKind: "browser-extension" }),
        user: { id: 42, role: "default" },
      }),
      { db }
    );

    expect(actor.id).toBe("42");
  });
});
