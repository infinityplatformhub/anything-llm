process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "pr4c-scopes-test-pepper-32-bytes";

/**
 * PR-4c: a key can no longer be minted with, or default to, the wildcard scope.
 *
 * Before this, `options.scopes || ["*"]` in the model and `@default("[\"*\"]")` in the
 * schema meant every key satisfied every route, however precisely PR-4b named them.
 */
jest.mock("../../utils/prisma", () => ({
  api_keys: { create: jest.fn() },
}));
// PR-4d (#35): ApiKey.create now asks the engine whether the creator may grant each
// scope. This suite's subject is the SHAPE validation that runs before that — the
// wildcard, the empty list, the typo — so the ceiling is stubbed to allow. Stubbing it
// here rather than mocking the whole policy store keeps the two concerns separable:
// keyScopeCeiling.test.js drives the real engine against real seeded grants.
jest.mock("../../utils/apiKeySecurity/scopeCeiling", () => ({
  ...jest.requireActual("../../utils/apiKeySecurity/scopeCeiling"),
  applyScopeCeiling: jest.fn(async ({ scopes }) => [...scopes]),
}));

const prisma = require("../../utils/prisma");
const { ApiKey } = require("../../models/apiKeys");
const {
  ADMIN_DEFAULT_SCOPES,
  SINGLE_USER_KEY_SCOPES,
  KNOWN_SCOPES,
  ROUTE_SCOPES,
} = require("../../utils/apiKeySecurity/scopes");

beforeEach(() => {
  jest.clearAllMocks();
  prisma.api_keys.create.mockResolvedValue({ id: 1, name: null, secretDigest: Buffer.from("x") });
});

const scopesWritten = () => JSON.parse(prisma.api_keys.create.mock.calls[0][0].data.scopes);

describe("ApiKey.create scope handling", () => {
  test("creating a key with no scopes is refused, not defaulted", async () => {
    const { apiKey, error } = await ApiKey.create(1, "no scopes");
    expect(apiKey).toBeNull();
    expect(error).toMatch(/explicit, non-empty scope list/);
    expect(prisma.api_keys.create).not.toHaveBeenCalled();
  });

  test("an empty scope list is refused rather than treated as unset", async () => {
    const { apiKey, error } = await ApiKey.create(1, "empty", { scopes: [] });
    expect(apiKey).toBeNull();
    expect(error).toMatch(/explicit, non-empty scope list/);
  });

  test("asking for the wildcard by name is refused", async () => {
    const { apiKey, error } = await ApiKey.create(1, "sneaky", { scopes: ["*"] });
    expect(apiKey).toBeNull();
    expect(error).toMatch(/wildcard scope no longer exists/);
  });

  test("a scope no route asks for is refused, so a typo cannot mint a dead key", async () => {
    const { apiKey, error } = await ApiKey.create(1, "typo", { scopes: ["workspace.raed"] });
    expect(apiKey).toBeNull();
    expect(error).toMatch(/Unknown scope\(s\): workspace\.raed/);
  });

  test("an explicit list is written through unchanged", async () => {
    const { error } = await ApiKey.create(1, "ok", { scopes: ["workspace.read", "chat.write"] });
    expect(error).toBeNull();
    expect(scopesWritten()).toEqual(["workspace.read", "chat.write"]);
  });
});

describe("the scope presets the mint sites use", () => {
  test("no preset contains the wildcard", () => {
    expect(ADMIN_DEFAULT_SCOPES).not.toContain("*");
    expect(SINGLE_USER_KEY_SCOPES).not.toContain("*");
    expect(KNOWN_SCOPES).not.toContain("*");
  });

  test("a retired scope says what replaced it, not that it is unknown (#64)", async () => {
    // `Unknown scope(s): chat.read` is true and useless — it reads as a typo, so the
    // caller's next move is to check their spelling rather than to grant the right
    // thing. A name that WAS valid should say so.
    const { apiKey, error } = await ApiKey.create(1, "retired", {
      scopes: ["chat.read"],
    });

    expect(apiKey).toBeNull();
    expect(error).toMatch(/retired in #64/);
    expect(error).toMatch(/chat\.read_others/);
    expect(error).not.toMatch(/Unknown scope/);
  });

  test("no all-users chat route has drifted back to chat.read (#64)", () => {
    // #64 NIT-2. The three routes that return EVERY user's chats declare
    // `chat.read_others`; `chat.read` would let a key read other people's chats with a
    // grant that does not say so, which is how it was before #64.
    //
    // Asserted per-route, not as `KNOWN_SCOPES` lacking `chat.read` entirely: a genuinely
    // self-only /v1 chat route would legitimately want `chat.read`, and a blanket ban
    // would fail the day someone adds one — pointing at the wrong thing. What must not
    // come back is these three declaring it.
    const ALL_USERS_CHAT_ROUTES = [
      "POST /v1/admin/workspace-chats",
      "GET /v1/workspace/:slug/chats",
      "GET /v1/workspace/:slug/thread/:threadSlug/chats",
    ];
    for (const route of ALL_USERS_CHAT_ROUTES) {
      expect(ROUTE_SCOPES[route]).toBe("chat.read_others");
    }
  });

  test("every preset entry is a scope some route actually asks for", () => {
    for (const preset of [ADMIN_DEFAULT_SCOPES, SINGLE_USER_KEY_SCOPES]) {
      expect(preset.every((scope) => KNOWN_SCOPES.includes(scope))).toBe(true);
      expect(preset.length).toBeGreaterThan(0);
    }
  });

  test("the admin preset withholds env access; single-user keeps it", () => {
    // An admin key administers the deployment; it does not thereby read the provider
    // credentials. A single-user operator is the deployment.
    expect(ADMIN_DEFAULT_SCOPES).not.toContain("system.env.read");
    expect(SINGLE_USER_KEY_SCOPES).toContain("system.env.read");
  });
});

describe("the wildcard is gone from the code paths that used to mint it", () => {
  test("the scopes module no longer exports a wildcard constant", () => {
    const scopes = require("../../utils/apiKeySecurity/scopes");
    expect(scopes.API_KEY_SCOPES).toBeUndefined();
    expect(JSON.stringify(scopes.ROUTE_SCOPES)).not.toContain('"*"');
  });

  test("the schema carries no wildcard default for the scopes column", () => {
    const fs = require("fs");
    const path = require("path");
    const schema = fs.readFileSync(
      path.resolve(__dirname, "../../prisma/schema.prisma"),
      "utf8"
    );
    const scopesLine = schema.split("\n").find((line) => line.includes("scopes"));
    expect(scopesLine).not.toContain("@default");
  });

  test("validApiKey does not short-circuit on a wildcard scope", () => {
    const fs = require("fs");
    const path = require("path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../utils/middleware/validApiKey.js"),
      "utf8"
    );
    expect(source).not.toContain('includes("*")');
  });
});
