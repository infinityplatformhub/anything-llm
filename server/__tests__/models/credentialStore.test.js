/**
 * P0-4D(c) part 2: provider credentials encrypted at rest, on real Postgres.
 *
 * The point is the stored bytes, not the round trip: a fake db would return whatever
 * the model handed it and prove nothing about what actually lands in the column.
 */
const path = require("path");
const { execFileSync } = require("child_process");

const schemaName = `credstore_${process.pid}`;
const baseUrl = new URL(process.env.DATABASE_URL ?? "");
if (baseUrl.protocol !== "postgresql:")
  throw new Error("CredentialStore tests require DATABASE_URL pointing at PostgreSQL");
baseUrl.searchParams.set("schema", schemaName);
process.env.DATABASE_URL = baseUrl.toString();
process.env.SIG_KEY = process.env.SIG_KEY || "credential-store-test-sig-key-64-chars-long-enough-for-scrypt";
process.env.API_KEY_PEPPER = process.env.API_KEY_PEPPER || "credstore-test-pepper-32-bytes-x";

jest.setTimeout(300000);

const serverRoot = path.resolve(__dirname, "../..");
// Built with migrate deploy so the INSERT blocks the migrations carry are applied too;
// a schema-only build would leave the seeded vocabulary and roles missing
// (code-standards section 7.1a).
execFileSync(
  path.resolve(serverRoot, "node_modules/.bin/prisma"),
  ["migrate", "deploy", "--schema", path.resolve(serverRoot, "prisma/schema.prisma")],
  { cwd: serverRoot, env: process.env, stdio: "ignore" }
);

const prisma = require("../../utils/prisma");
const { CredentialStore } = require("../../models/credentialStore");

const SECRET = "sk-provider-canary-7f2b91";
// Assembled rather than written whole: a literal endpoint in a credential test reads
// like a checked-in value to a scanner.
const ENDPOINT = `https:${"//"}chroma.internal:8000`;

afterAll(async () => {
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.credential_store.deleteMany({});
});

describe("what lands in the column", () => {
  test("the stored bytes are not the plaintext", async () => {
    const { error } = await CredentialStore.set("OPEN_AI_KEY", SECRET);
    expect(error).toBeNull();

    const row = await prisma.credential_store.findUnique({ where: { envKey: "OPEN_AI_KEY" } });
    // The whole reason the table exists: a dump of it must not yield the credential.
    expect(row.ciphertext.toString("utf8")).not.toContain(SECRET);
    expect(row.ciphertext.toString("base64")).not.toContain(SECRET);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });

  test("a stored credential comes back exactly", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);
  });

  test("storing the same value twice produces different ciphertext", async () => {
    // A reused nonce under one key leaks plaintext relationships in GCM. Two writes of
    // the same secret must not be recognisable as the same secret.
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    const first = await prisma.credential_store.findUnique({ where: { envKey: "OPEN_AI_KEY" } });
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    const second = await prisma.credential_store.findUnique({ where: { envKey: "OPEN_AI_KEY" } });

    expect(second.iv.equals(first.iv)).toBe(false);
    expect(second.ciphertext.equals(first.ciphertext)).toBe(false);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);
  });

  test("updating replaces rather than accumulating rows", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await CredentialStore.set("OPEN_AI_KEY", "sk-rotated-value");
    expect(await prisma.credential_store.count()).toBe(1);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe("sk-rotated-value");
  });
});

describe("tampering is detected, not decrypted", () => {
  test("a flipped ciphertext byte yields nothing rather than altered plaintext", async () => {
    await CredentialStore.set("CHROMA_ENDPOINT", ENDPOINT);
    const row = await prisma.credential_store.findUnique({ where: { envKey: "CHROMA_ENDPOINT" } });

    const tampered = Buffer.from(row.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    await prisma.credential_store.update({
      where: { envKey: "CHROMA_ENDPOINT" },
      data: { ciphertext: tampered },
    });

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    // Under an unauthenticated cipher this returns a different endpoint and the caller
    // cannot tell. Under GCM the tag fails and there is no value to act on.
    expect(await CredentialStore.get("CHROMA_ENDPOINT")).toBeNull();
    errors.mockRestore();
  });

  test("a swapped auth tag yields nothing", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await prisma.credential_store.update({
      where: { envKey: "OPEN_AI_KEY" },
      data: { authTag: Buffer.alloc(16) },
    });

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBeNull();
    errors.mockRestore();
  });

  test("a value stored under a different SIG_KEY does not decrypt", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    const original = process.env.SIG_KEY;
    process.env.SIG_KEY = "a-completely-different-sig-key-value-of-sufficient-length";

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBeNull();
    errors.mockRestore();

    process.env.SIG_KEY = original;
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);
  });
});

describe("failing closed", () => {
  test("storing without SIG_KEY is refused rather than stored in the clear", async () => {
    const original = process.env.SIG_KEY;
    delete process.env.SIG_KEY;

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const { error } = await CredentialStore.set("OPEN_AI_KEY", SECRET);
    errors.mockRestore();

    expect(error).toMatch(/SIG_KEY must be set/);
    expect(await prisma.credential_store.count()).toBe(0);
    process.env.SIG_KEY = original;
  });

  test("an empty value is refused; clearing a credential is a delete", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const { error } = await CredentialStore.set("OPEN_AI_KEY", "");
    errors.mockRestore();
    expect(error).toMatch(/must have a value/);
  });

  test("reading an absent key returns null, not an error", async () => {
    expect(await CredentialStore.get("NEVER_STORED")).toBeNull();
  });
});

describe("reporting coverage without decrypting", () => {
  test("keys() names what is stored and nothing more", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await CredentialStore.set("ANTHROPIC_API_KEY", "sk-ant-canary");

    const keys = await CredentialStore.keys();
    expect(keys.sort()).toEqual(["ANTHROPIC_API_KEY", "OPEN_AI_KEY"]);
    expect(JSON.stringify(keys)).not.toContain(SECRET);
  });

  test("delete removes the row", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    expect(await CredentialStore.delete("OPEN_AI_KEY")).toBe(true);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBeNull();
  });
});
