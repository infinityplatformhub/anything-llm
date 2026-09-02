const prisma = require("../../utils/prisma");
const { PG_SCHEME } = require("../../utils/test/postgresUrl");
const { ApiKey } = require("../../models/apiKeys");
const { BrowserExtensionApiKey } = require("../../models/browserExtensionApiKey");

const run = process.env.DATABASE_URL?.startsWith(PG_SCHEME) ? describe : describe.skip;

run("HMAC API key PostgreSQL integration", () => {
  beforeAll(() => { process.env.API_KEY_PEPPER = "postgres-integration-pepper-32-bytes"; });
  beforeEach(async () => {
    await prisma.api_keys.deleteMany();
    await prisma.browser_extension_api_keys.deleteMany();
  });
  afterAll(() => prisma.$disconnect());

  test("stores only digest and returns raw API key once", async () => {
    const { apiKey, error } = await ApiKey.create(null, "integration", { scopes: ["workspace.read"] });
    expect(error).toBeNull();
    expect(apiKey.secret).toMatch(/^apw-key-/);
    const stored = await prisma.api_keys.findUnique({ where: { id: apiKey.id } });
    expect(stored.secretDigest).toBeInstanceOf(Buffer);
    expect(stored.keyPrefix).toBe(apiKey.secret.slice(0, 16));
    expect(Object.hasOwn(stored, "secret")).toBe(false);
    expect(await ApiKey.resolve(apiKey.secret)).toMatchObject({ id: apiKey.id, scopes: ["workspace.read"] });
    expect(await ApiKey.resolve(`${apiKey.secret}wrong`)).toBeNull();
  });

  test("rejects expired and revoked keys and updates last use", async () => {
    const { apiKey } = await ApiKey.create(null, null, { scopes: ["workspace.read"] });
    await ApiKey.touch(apiKey.id);
    expect((await prisma.api_keys.findUnique({ where: { id: apiKey.id } })).lastUsedAt).toBeInstanceOf(Date);
    await prisma.api_keys.update({ where: { id: apiKey.id }, data: { revokedAt: new Date() } });
    expect(await ApiKey.resolve(apiKey.secret)).toBeNull();
    const expired = await ApiKey.create(null, null, { scopes: ["workspace.read"], expiresAt: new Date(Date.now() - 1000) });
    expect(await ApiKey.resolve(expired.apiKey.secret)).toBeNull();
  });


  test("DB dump digest and prefix cannot authenticate without pepper", async () => {
    const { apiKey } = await ApiKey.create(null, null, { scopes: ["workspace.read"] });
    const stored = await prisma.api_keys.findUnique({ where: { id: apiKey.id } });
    const candidate = `${stored.keyPrefix}${stored.secretDigest.toString("base64url")}`;
    expect(await ApiKey.resolve(candidate)).toBeNull();
  });

  test("rotating pepper invalidates every existing key", async () => {
    const issued = await Promise.all(Array.from({ length: 10 }, () => ApiKey.create(null, null, { scopes: ["workspace.read"] })));
    process.env.API_KEY_PEPPER = "rotated-postgres-pepper-32-bytes-value";
    for (const { apiKey } of issued) expect(await ApiKey.resolve(apiKey.secret)).toBeNull();
    process.env.API_KEY_PEPPER = "postgres-integration-pepper-32-bytes";
  });

  test("malformed scope storage defaults deny instead of all", async () => {
    const malformed = ["[]", "null", JSON.stringify("workspace.write"), "{" ];
    for (const scopes of malformed) {
      const { apiKey } = await ApiKey.create(null, null, { scopes: ["workspace.read"] });
      await prisma.api_keys.update({ where: { id: apiKey.id }, data: { scopes } });
      expect((await ApiKey.resolve(apiKey.secret)).scopes).toEqual([]);
    }
  });

  test("browser extension keys use separate prefix and no plaintext column", async () => {
    const { apiKey } = await BrowserExtensionApiKey.create(null, null, { scopes: ["workspace.read"] });
    expect(apiKey.secret).toMatch(/^apw-brx-/);
    const stored = await prisma.browser_extension_api_keys.findUnique({ where: { id: apiKey.id } });
    expect(Object.hasOwn(stored, "key")).toBe(false);
    expect(await BrowserExtensionApiKey.validate(apiKey.secret)).toMatchObject({ id: apiKey.id });
  });
});
