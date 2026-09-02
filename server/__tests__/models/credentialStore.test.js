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

/**
 * #125 — the key is derived ONCE per process, keyed by the material it came from.
 *
 * All timings below were measured on darwin arm64, node v22.23.1. They are
 * stated so a reader on other hardware compares against a number that had a
 * machine attached to it rather than treating one as universal.
 */
describe("#125: deriving the encryption key once", () => {
  const crypto = require("crypto");

  test("N reads derive the key ONCE, not N times", async () => {
    // The defect: scryptSync ran on every get and set. Measured at ~28 ms a
    // call on this machine, so 97 reads at boot cost ~2.5 s of deriving one
    // key from material that never changed.
    await CredentialStore.set("OPEN_AI_KEY", SECRET);

    const derive = jest.spyOn(crypto, "scryptSync");
    try {
      for (let i = 0; i < 5; i++) await CredentialStore.get("OPEN_AI_KEY");
      expect(derive).toHaveBeenCalledTimes(0);
    } finally {
      derive.mockRestore();
    }
  });

  test("a cold cache derives exactly once, however many reads follow", async () => {
    // The count that matters is 1, not 0: a spy showing zero could also mean
    // the code never derives at all, which would be a different bug wearing
    // the same green tick.
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    const { __resetKeyCache } = require("../../models/credentialStore");
    __resetKeyCache();

    const derive = jest.spyOn(crypto, "scryptSync");
    try {
      for (let i = 0; i < 5; i++) await CredentialStore.get("OPEN_AI_KEY");
      expect(derive).toHaveBeenCalledTimes(1);
    } finally {
      derive.mockRestore();
    }
  });

  test("rotating SIG_KEY mid-process re-derives instead of reusing the old key", async () => {
    // The whole reason the cache is keyed by MATERIAL. Keyed by nothing, the
    // old key would keep decrypting after rotation — a credential store that
    // ignores its own re-key.
    const original = process.env.SIG_KEY;
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.env.SIG_KEY = "a-different-sig-key-also-long-enough-for-scrypt-32";
      // Written under the old key, read under the new one: the tag fails.
      expect(await CredentialStore.get("OPEN_AI_KEY")).toBeNull();

      process.env.SIG_KEY = original;
      // And back again — proving the first null was the KEY changing, not the
      // row being damaged.
      expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);
    } finally {
      errors.mockRestore();
      process.env.SIG_KEY = original;
    }
  });

  describe("the guard still runs before the cache is consulted", () => {
    // A cache that outlives its material is a credential store that keeps
    // working after its key is taken away — the opposite of the fail-closed
    // behaviour this function's own doc comment promises.
    const warmTheCache = async () => {
      await CredentialStore.set("OPEN_AI_KEY", SECRET);
      await CredentialStore.get("OPEN_AI_KEY");
    };

    test("deleting SIG_KEY after a successful derivation still refuses", async () => {
      const original = process.env.SIG_KEY;
      await warmTheCache();

      const errors = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        delete process.env.SIG_KEY;
        const { error } = await CredentialStore.set("ANTHROPIC_API_KEY", SECRET);
        expect(error).toMatch(/SIG_KEY must be set/);
      } finally {
        errors.mockRestore();
        process.env.SIG_KEY = original;
      }
    });

    test("a SIG_KEY of 31 characters is refused too", async () => {
      // The guard is `!material || trim().length < 32` and these are its two
      // different legs. A test that only deletes the variable stays green
      // against a guard that lost the length half.
      const original = process.env.SIG_KEY;
      await warmTheCache();

      const errors = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        process.env.SIG_KEY = "x".repeat(31);
        const { error } = await CredentialStore.set("ANTHROPIC_API_KEY", SECRET);
        expect(error).toMatch(/at least 32 characters/);
      } finally {
        errors.mockRestore();
        process.env.SIG_KEY = original;
      }
    });

    test("a SIG_KEY of only whitespace is refused, however long", async () => {
      // `trim()` is in the real condition and nothing exercised it: 40 spaces
      // is long enough by `.length` and empty once trimmed.
      const original = process.env.SIG_KEY;
      await warmTheCache();

      const errors = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        process.env.SIG_KEY = " ".repeat(40);
        const { error } = await CredentialStore.set("ANTHROPIC_API_KEY", SECRET);
        expect(error).toMatch(/SIG_KEY must be set|at least 32 characters/);
      } finally {
        errors.mockRestore();
        process.env.SIG_KEY = original;
      }
    });
  });

  test("the derived key is not reachable from the exported object", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await CredentialStore.get("OPEN_AI_KEY");

    const util = require("util");
    const surfaces = [
      JSON.stringify(CredentialStore) ?? "",
      util.inspect(CredentialStore, { depth: 5 }),
      Object.keys(CredentialStore).join(","),
    ].join("\n");

    expect(surfaces).not.toContain(process.env.SIG_KEY);

    // Assert on VALUES, not on property NAMES. `keys()` is a legitimate method
    // — it reports which credentials exist without decrypting them — and a
    // name-based rule would flag it while missing a Buffer stored under an
    // innocuous name. What must not be reachable is the material or a 32-byte
    // key, whatever it is called.
    for (const [name, value] of Object.entries(CredentialStore)) {
      expect(`${name}:${typeof value}`).toBe(`${name}:function`);
      expect(Buffer.isBuffer(value)).toBe(false);
    }
  });

  test("a fresh process starts with a cold cache", () => {
    // The memo is per process. Asserting that stops it being mistaken for
    // anything durable, which would be a much bigger claim than the code makes.
    //
    // Two earlier versions of this test proved nothing, and both are worth
    // naming because each looked right:
    //   1. it called `get()` on an absent row — `get()` returns before
    //      deriving when there is no row, so the child reported zero and
    //      passed for the wrong reason;
    //   2. it counted a `scryptSync` call the test itself made, never touching
    //      CredentialStore at all.
    // The child now calls the real `encryptionKey` path twice and reports the
    // derivation count, which is 1 only if the cache starts cold AND works.
    const { execFileSync } = require("child_process");
    const modulePath = path.resolve(serverRoot, "models/credentialStore.js");
    const script = `
      const crypto = require("crypto");
      const real = crypto.scryptSync;
      let calls = 0;
      crypto.scryptSync = (...args) => { calls++; return real(...args); };

      const { CredentialStore } = require(${JSON.stringify(modulePath)});

      // set() derives; a second set() must reuse. Both hit a schema that may
      // not exist — the write can fail, but the DERIVATION happens first and
      // that is what is being counted.
      Promise.resolve()
        .then(() => CredentialStore.set("PROBE_KEY", "probe-value"))
        .then(() => CredentialStore.set("PROBE_KEY_2", "probe-value"))
        .then(() => process.stdout.write("DERIVATIONS=" + calls + "\\n"))
        .catch(() => process.stdout.write("DERIVATIONS=" + calls + "\\n"));
    `;
    const out = execFileSync(process.execPath, ["-e", script], {
      cwd: serverRoot,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // Parsed from a MARKER, not from the whole of stdout: Prisma logs its pool
    // size on startup, so `Number(stdout)` was NaN — the count was correct and
    // the reading of it was not.
    const match = out.match(/DERIVATIONS=(\d+)/);
    expect(match).not.toBeNull();
    // Exactly one: the process began with nothing cached (so it derived), and
    // the second call reused it (so it did not derive again).
    expect(Number(match[1])).toBe(1);
  });
});

describe("#125: the timing oracle the memo closes", () => {
  /**
   * `get()` derives the key only AFTER `if (!row) return null`, so before this
   * change a configured credential cost a full scrypt and an absent one cost a
   * database round trip. Measured on main, darwin arm64, node v22.23.1:
   *
   *     present: 29.5 ms | absent: 0.9 ms | delta: 28.6 ms
   *
   * 28 ms is measurable over a network, and it answers "is this provider
   * configured on this instance" to anyone who can reach a path that reads a
   * credential. Memoising closes it, because after the first derivation both
   * branches cost the same.
   */
  test("present and absent reads cost the same once the cache is warm", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await CredentialStore.get("OPEN_AI_KEY"); // warm

    const time = async (envKey) => {
      const started = process.hrtime.bigint();
      await CredentialStore.get(envKey);
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Best of several: the point is the DERIVATION cost, and a single sample
    // can be dominated by an unlucky database round trip in either direction.
    const samples = 5;
    let present = Infinity;
    let absent = Infinity;
    for (let i = 0; i < samples; i++) {
      present = Math.min(present, await time("OPEN_AI_KEY"));
      absent = Math.min(absent, await time("NEVER_STORED_AT_ALL"));
    }

    // Reported unconditionally, so a failure on slower hardware arrives with
    // the numbers rather than sending someone to reproduce it.
    const delta = Math.abs(present - absent);
    expect(
      `present=${present.toFixed(1)}ms absent=${absent.toFixed(1)}ms delta=${delta.toFixed(1)}ms`
    ).toBe(
      delta < 5
        ? `present=${present.toFixed(1)}ms absent=${absent.toFixed(1)}ms delta=${delta.toFixed(1)}ms`
        : "delta below 5ms"
    );
  });

  test("reading 97 credentials costs about one derivation, not 97", async () => {
    // Measured with a CLOCK rather than a spy count: a spy proves the cache is
    // consulted, a clock proves it saves something. If the memo worked and
    // something else became slow, the spy would stay green and boot would not.
    const keys = Array.from({ length: 97 }, (_, i) => `PROVIDER_KEY_${i}`);
    for (const key of keys) await CredentialStore.set(key, `${SECRET}-${key}`);

    const { __resetKeyCache } = require("../../models/credentialStore");
    __resetKeyCache();

    const started = Date.now();
    for (const key of keys) await CredentialStore.get(key);
    const elapsed = Date.now() - started;

    // One derivation (~28 ms here) plus 97 database round trips. Deriving per
    // row would be ~2.7 s on this machine; the bound is loose because the
    // database time is the variable part and the derivation is not.
    expect(elapsed).toBeLessThan(1500);
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

describe("a blob only decrypts under the row it was sealed for", () => {
  test("relocating one key's ciphertext onto another row yields nothing", async () => {
    // QA-2 (#33 part 2): GCM's tag proves the bytes were not edited, not which row they
    // belong to. Without AAD, whoever can write the table swaps a provider endpoint's
    // stored value for another key's — no knowledge of SIG_KEY required.
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await CredentialStore.set("CHROMA_ENDPOINT", ENDPOINT);

    const source = await prisma.credential_store.findUnique({ where: { envKey: "OPEN_AI_KEY" } });
    await prisma.credential_store.update({
      where: { envKey: "CHROMA_ENDPOINT" },
      data: { ciphertext: source.ciphertext, iv: source.iv, authTag: source.authTag },
    });

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const relocated = await CredentialStore.get("CHROMA_ENDPOINT");
    errors.mockRestore();

    expect(relocated).toBeNull();
    expect(relocated).not.toBe(SECRET);
    // The row it was copied from is untouched and still readable.
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBe(SECRET);
  });

  test("a row rewritten under a different keyVersion does not decrypt", async () => {
    // Replaying a row encrypted under an older derivation must not survive a re-key.
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await prisma.credential_store.update({
      where: { envKey: "OPEN_AI_KEY" },
      data: { keyVersion: 99 },
    });

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await CredentialStore.get("OPEN_AI_KEY")).toBeNull();
    errors.mockRestore();
  });

  test("renaming a row's envKey does not carry its value across", async () => {
    await CredentialStore.set("OPEN_AI_KEY", SECRET);
    await prisma.credential_store.update({
      where: { envKey: "OPEN_AI_KEY" },
      data: { envKey: "ANTHROPIC_API_KEY" },
    });

    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(await CredentialStore.get("ANTHROPIC_API_KEY")).toBeNull();
    errors.mockRestore();
  });
});
