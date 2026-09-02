// S11a (#80) — the save gate: a configuration is "verified" only while it is the
// one that actually sent something.
//
// RED-first: written before `mailerSettings` enforces any of this.
//
// The failure this prevents is quiet. An operator tests one host, edits the form,
// saves, and the settings page still reports the configuration as confirmed
// working — so when invites stop arriving, the one screen that could say
// otherwise agrees that everything is fine.

const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");

const SERVER_DIR = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const suffix = crypto.randomBytes(4).toString("hex");
const testSchemaName = `s11a_settings_${suffix}`;

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith("postgresql:"))
  throw new Error("DATABASE_URL must point at PostgreSQL for this suite");
const testUrl = new URL(baseDatabaseUrl);
testUrl.searchParams.set("schema", testSchemaName);
process.env.DATABASE_URL = testUrl.toString();
process.env.SIG_KEY =
  process.env.SIG_KEY || "test-sig-key-at-least-32-characters-long";

let prisma;
let mailerSettings;

const PASSWORD = "Sup3rSecret!Mail#2026";
const CONFIG = {
  smtp_allow_untrusted_cert: "false",
  // Dotless on purpose (QA-3): the audit redaction's email pattern needs a `.`
  // in the host, so a leak through an FQDN would be scrubbed by coincidence and
  // hide the very thing under test.
  smtp_host: "smtp",
  smtp_port: "587",
  smtp_secure: "false",
  smtp_allow_insecure: "true",
  smtp_username: "mailer",
  smtp_from_address: "no-reply@example.com",
  smtp_from_name: "ApproofWorkspace",
};

async function writeSettings(values) {
  for (const [label, value] of Object.entries(values))
    await prisma.system_settings.upsert({
      where: { label },
      update: { value: String(value) },
      create: { label, value: String(value) },
    });
}

beforeAll(async () => {
  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", SCHEMA], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: "pipe",
  });
  prisma = new PrismaClient({
    datasources: { db: { url: testUrl.toString() } },
  });
  mailerSettings = require("../../../utils/notifications/mailerSettings");
}, 300_000);

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`
  );
  await admin.$disconnect();
});

beforeEach(async () => {
  await prisma.system_settings.deleteMany({});
});

describe("issue 80: the verified hash describes one exact configuration", () => {
  test("the same config and password produce the same hash", async () => {
    // Guard the guard: a hash that changed on every call would make every
    // assertion below pass while proving nothing.
    const first = mailerSettings.configHash(CONFIG, PASSWORD);
    const second = mailerSettings.configHash(CONFIG, PASSWORD);
    expect(first).toBe(second);
  });

  test("TL-2 GAP-1: every field that determines a connection is in the hash", async () => {
    // Named EXPLICITLY, not read from SETTING_KEYS. Iterating the list is what
    // the test below does, and it has a hole: delete a key from the list and its
    // own case disappears with it, so the suite stays green while a
    // connection-determining field silently stops invalidating the proof.
    // Measured — dropping `smtp_allow_untrusted_cert` left 12/12 passing.
    const REQUIRED_IN_HASH = [
      "smtp_host",
      "smtp_port",
      "smtp_secure",
      "smtp_allow_insecure",
      "smtp_allow_untrusted_cert",
      "smtp_username",
      "smtp_from_address",
      "smtp_from_name",
    ];
    expect([...mailerSettings.SETTING_KEYS].sort()).toEqual(
      [...REQUIRED_IN_HASH].sort()
    );

    const base = mailerSettings.configHash(CONFIG, PASSWORD);
    for (const key of REQUIRED_IN_HASH) {
      const altered = mailerSettings.configHash(
        { ...CONFIG, [key]: `${CONFIG[key]}-changed` },
        PASSWORD
      );
      expect(`${key}:${altered}`).not.toBe(`${key}:${base}`);
    }
  });

  test("changing ANY connection field changes the hash", async () => {
    const base = mailerSettings.configHash(CONFIG, PASSWORD);
    for (const key of mailerSettings.SETTING_KEYS) {
      const altered = mailerSettings.configHash(
        { ...CONFIG, [key]: `${CONFIG[key]}-changed` },
        PASSWORD
      );
      // Named in the failure message, because "one of seven fields is not in the
      // hash" is otherwise a puzzle.
      expect(`${key}:${altered}`).not.toBe(`${key}:${base}`);
    }
  });

  test("M4: rotating the PASSWORD changes the hash", async () => {
    // The case a hash over non-secret fields alone would miss. A rotated
    // password is a different configuration — one the old test never exercised —
    // and treating it as verified is how "confirmed working" outlives the
    // credential that made it true.
    const base = mailerSettings.configHash(CONFIG, PASSWORD);
    const rotated = mailerSettings.configHash(CONFIG, "a-different-password");
    expect(rotated).not.toBe(base);
  });

  test("the hash reveals neither the password nor the host", async () => {
    // It is stored in `system_settings`, which is read by anything with settings
    // access and lands in backups.
    const hash = mailerSettings.configHash(CONFIG, PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash).not.toContain("mailer");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("it is keyed: the same inputs under a different SIG_KEY differ", async () => {
    // An unkeyed digest over a host, a port and a username is precomputable, so
    // anyone able to write one settings row could forge a verified marker for a
    // configuration nobody tested.
    const withOriginal = mailerSettings.configHash(CONFIG, PASSWORD);
    const previous = process.env.SIG_KEY;
    try {
      process.env.SIG_KEY = "a-completely-different-key-at-least-32-chars";
      expect(mailerSettings.configHash(CONFIG, PASSWORD)).not.toBe(
        withOriginal
      );
    } finally {
      process.env.SIG_KEY = previous;
    }
  });

  test("without SIG_KEY it refuses to produce a hash at all", async () => {
    const previous = process.env.SIG_KEY;
    try {
      delete process.env.SIG_KEY;
      expect(() => mailerSettings.configHash(CONFIG, PASSWORD)).toThrow();
    } finally {
      process.env.SIG_KEY = previous;
    }
  });
});

describe("issue 80: isVerified answers about the CURRENT settings", () => {
  test("settings that were verified read as verified", async () => {
    await writeSettings({
      ...CONFIG,
      [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
        CONFIG,
        PASSWORD
      ),
    });
    expect(await mailerSettings.isVerified(PASSWORD)).toBe(true);
  });

  test("editing the host after verifying makes it unverified again", async () => {
    // The mockup-B failure, at the layer that decides. No flag is cleared by
    // hand; the stored proof simply stops describing the settings.
    await writeSettings({
      ...CONFIG,
      [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
        CONFIG,
        PASSWORD
      ),
    });
    await writeSettings({ smtp_host: "other-smtp" });

    expect(await mailerSettings.isVerified(PASSWORD)).toBe(false);
  });

  test("rotating the password makes it unverified again", async () => {
    await writeSettings({
      ...CONFIG,
      [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
        CONFIG,
        PASSWORD
      ),
    });
    expect(await mailerSettings.isVerified("the-new-password")).toBe(false);
  });

  test("no stored hash means not verified", async () => {
    await writeSettings(CONFIG);
    expect(await mailerSettings.isVerified(PASSWORD)).toBe(false);
  });

  test("a forged hash does not verify", async () => {
    await writeSettings({
      ...CONFIG,
      [mailerSettings.VERIFIED_HASH_KEY]: crypto
        .createHash("sha256")
        .update("guessed")
        .digest("hex"),
    });
    expect(await mailerSettings.isVerified(PASSWORD)).toBe(false);
  });

  test("it fails CLOSED when SIG_KEY is missing", async () => {
    // Unverifiable is not the same as verified. Without the key nothing can be
    // checked, and the safe answer is no.
    await writeSettings({
      ...CONFIG,
      [mailerSettings.VERIFIED_HASH_KEY]: mailerSettings.configHash(
        CONFIG,
        PASSWORD
      ),
    });
    const previous = process.env.SIG_KEY;
    try {
      delete process.env.SIG_KEY;
      expect(await mailerSettings.isVerified(PASSWORD)).toBe(false);
    } finally {
      process.env.SIG_KEY = previous;
    }
  });
});
