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

const prisma = require("../../utils/prisma");
const { ApiKey } = require("../../models/apiKeys");
const {
  ADMIN_DEFAULT_SCOPES,
  SINGLE_USER_KEY_SCOPES,
  KNOWN_SCOPES,
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
