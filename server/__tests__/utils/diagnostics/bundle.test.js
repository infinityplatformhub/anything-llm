/* eslint-env jest */

/**
 * O5b (#94) — the diagnostic bundle.
 *
 * The bundle is a FILE, and files get shared: attached to an issue, pasted in a
 * chat, mailed to support. So the test that matters here is not "is each field
 * shaped right" but "does anything I planted anywhere come back out". It seeds a
 * known marker into every reachable source and scans the SERIALISED bundle as
 * one string.
 *
 * Whole-string, deliberately, rather than per-field assertions: a section added
 * later without redaction fails THIS test instead of needing a new one that
 * nobody writes. Same shape as __tests__/envDumpGuardHttp.test.js.
 *
 * No database is required — collectDatabase takes an injected client, and the
 * fake below is closer to a broken install than a healthy dev box is anyway.
 */
const {
  scrubText,
  ENV_ALLOWLIST,
  DERIVED_ENV_KEYS,
  UNDECLARED_ENV_KEYS,
  URL_SHAPED_KEYS,
  COUNTED_TABLES,
  collectEnv,
  collectDatabase,
  buildBundle,
  KEY_MAPPING,
} = require("../../../utils/diagnostics");

// Every marker is a distinct literal so a failure names which source leaked.
const SEEDED = {
  dbPassword: "sup3rsecret-db-password",
  undeclaredSecret: "UNDECLARED-KEY-VALUE-9k2",
  credential: "apw-key-AAAABBBBCCCCDDDDEEEE",
  email: "customer.person@example.com",
  thaiId: "1234567890123",
};

const seededEnv = () => ({
  NODE_ENV: "production",
  SERVER_PORT: "3001",
  STORAGE_DIR: "/app/server/storage",
  DATABASE_URL: `postgresql://appuser:${SEEDED.dbPassword}@db.internal:5432/anythingllm`,
  VECTOR_DB: "lancedb",
  LLM_PROVIDER: "openai",
  // Not in the allowlist. The whole point: a key nobody declared must not
  // arrive because it "looked harmless".
  OPEN_AI_KEY: SEEDED.undeclaredSecret,
  SOME_FUTURE_KEY: SEEDED.undeclaredSecret,
});

// A client whose rows carry the markers in free text — the shape of a real
// database whose migration names, event names and error strings were written by
// someone else.
const seededClient = () => ({
  query: async (sql) => {
    if (sql.includes("_prisma_migrations"))
      return {
        rows: [
          {
            migration_name: `20260902100000_add_index_for_${SEEDED.email}`,
            applied_steps_count: 1,
            finished_at: null,
            rolled_back_at: null,
          },
        ],
      };
    if (sql.includes("server_version")) return { rows: [{ server_version: "16.4" }] };
    if (sql.includes("GROUP BY event"))
      return {
        rows: [
          { event: "login", n: 4 },
          { event: `note_${SEEDED.thaiId}`, n: 1 },
        ],
      };
    return { rows: [{ n: 7 }] };
  },
});

const checksWithMarkers = () => [
  {
    id: "db.reachable",
    ok: true,
    level: "block",
    detail: `Connected as ${SEEDED.email} using ${SEEDED.credential}.`,
    remedy: "",
  },
];

describe("O5b bundle — the helpers it reuses are actually exported (TL-1 F1)", () => {
  // Both were used before they were exported, so `collectEnv` threw
  // "stripUrlCredentials is not a function" at the first call. A require of the
  // module alone does not catch it: the failure is at call time, in a branch a
  // shape test never reaches.
  it("stripUrlCredentials is exported from updateENV", () => {
    const { stripUrlCredentials } = require("../../../utils/helpers/updateENV");
    expect(typeof stripUrlCredentials).toBe("function");
  });

  it("scrubValue is exported from redaction", () => {
    const { scrubValue } = require("../../../utils/events/redaction");
    expect(typeof scrubValue).toBe("function");
  });

  it("uses scrubValue rather than redactEventData, which would empty the bundle", () => {
    // `redactEventData` applies the audit ALLOWLIST to top-level keys. The
    // bundle's own section names are not audit-event data keys, so it would
    // return `{_droppedKeyCount: n}` and nothing else — a bundle that is
    // perfectly redacted and completely useless.
    const { redactEventData } = require("../../../utils/events/redaction");
    const throughAudit = redactEventData({
      versions: {},
      environment: {},
      database: {},
      resources: {},
    });
    expect(Object.keys(throughAudit.data)).toEqual(["_droppedKeyCount"]);
  });

  it("uses stripUrlCredentials rather than maskSecretValues, which masks the whole value", () => {
    // `maskSecretValues` keys by KEY_MAPPING SETTING name (`OpenAiKey`), not by
    // env key (`OPEN_AI_KEY`), so every env key is undeclared to it and every
    // value comes back fully masked — including DATABASE_URL, whose host is the
    // diagnostic part.
    const { maskSecretValues } = require("../../../utils/helpers/updateENV");
    const masked = maskSecretValues({ DATABASE_URL: seededEnv().DATABASE_URL });
    expect(masked.DATABASE_URL).toBe("**********");
  });
});

describe("O5b bundle — nothing seeded comes back out", () => {
  // The Thai national ID here is seeded into an EVENT NAME (`note_<13 digits>`)
  // rather than a plain field, and that is deliberate. It was red when this test
  // was written: `redaction.js` anchored its numeric patterns with `\b`, and `_`
  // is a word character, so the ID survived while every other seeded marker was
  // removed. That was a live PDPA leak in the shared audit redaction, fixed as
  // #95. Left seeded exactly as written so this goes red again if that fix is
  // ever reverted.
  it("no seeded secret, credential or PII appears anywhere in the serialised bundle", async () => {
    const { bundle } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: checksWithMarkers(),
    });

    const serialised = JSON.stringify(bundle);
    for (const [source, marker] of Object.entries(SEEDED)) {
      expect(`${source}:${serialised.includes(marker)}`).toBe(`${source}:false`);
    }
  });

  it("names the redaction classes that fired, so the operator knows something was removed", async () => {
    const { redactions } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: checksWithMarkers(),
    });
    expect(redactions).toEqual(expect.arrayContaining(["email", "credential"]));
  });

  it("reports url_credentials when an embedded connection string was stripped", async () => {
    // The strip is a redaction like any other and must be named. A scrub that
    // removes things while reporting nothing lets an operator believe the file
    // is untouched.
    const { redactions } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: [
        {
          id: "db.reachable",
          ok: true,
          level: "block",
          detail: "Connected to postgresql://appuser:hunter2@postgres:5432/x.",
          remedy: "",
        },
      ],
    });
    expect(redactions).toContain("url_credentials");
  });

  it("still reports the fields the operator needs, so the bundle is not just masked noise", async () => {
    const { bundle } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: [],
    });
    expect(bundle.environment.VECTOR_DB).toBe("lancedb");
    expect(bundle.environment.LLM_PROVIDER).toBe("openai");
    expect(bundle.versions.node).toBe(process.version);
    expect(bundle.database.serverVersion).toBe("16.4");
  });
});

describe("O5b bundle — the environment allowlist", () => {
  it("is frozen, so a caller cannot widen it at runtime", () => {
    expect(Object.isFrozen(ENV_ALLOWLIST)).toBe(true);
  });

  // TL-1 F2: the previous version of this test filtered the allowlist by
  // `secret === true` and asserted the result was empty. It was self-satisfying
  // (§7.9f): a key KEY_MAPPING does not declare at all is not `secret === true`,
  // so an undeclared secret passed it, and `secret: "url"` — a value that
  // carries credentials in its userinfo — passed it too. The two tests below
  // replace it, and each checks the thing its own list actually claims.
  it("resolves every DERIVED key in KEY_MAPPING and requires secret === false", () => {
    const byEnvKey = new Map(
      Object.values(KEY_MAPPING).map((entry) => [entry.envKey, entry])
    );
    for (const key of DERIVED_ENV_KEYS) {
      const entry = byEnvKey.get(key);
      // Named per key so a failure says which one, not just "expected true".
      expect(`${key}:${entry ? "declared" : "missing"}`).toBe(`${key}:declared`);
      // `=== false`, not `!== true`: `secret: "url"` is neither, and waving it
      // through as ordinary configuration is exactly the hole this closes.
      expect(`${key}:${entry.secret}`).toBe(`${key}:false`);
    }
  });

  it("requires every UNDECLARED key to be genuinely undeclared and to carry a reason", () => {
    const declared = new Set(
      Object.values(KEY_MAPPING).map((entry) => entry.envKey)
    );
    for (const [key, reason] of Object.entries(UNDECLARED_ENV_KEYS)) {
      // A key that later GAINS a declaration must move to DERIVED and be
      // checked against it, rather than keep an exemption it no longer needs.
      expect(`${key}:${declared.has(key)}`).toBe(`${key}:false`);
      expect(typeof reason).toBe("string");
      expect(reason.trim().length).toBeGreaterThan(20);
    }
  });

  it("puts DATABASE_URL in neither list, because it is transformed rather than allowed", () => {
    expect(DERIVED_ENV_KEYS).not.toContain("DATABASE_URL");
    expect(Object.keys(UNDECLARED_ENV_KEYS)).not.toContain("DATABASE_URL");
    expect(URL_SHAPED_KEYS).toContain("DATABASE_URL");
  });

  it("builds the allowlist from the two lists plus the transformed key, with nothing extra", () => {
    expect([...ENV_ALLOWLIST].sort()).toEqual(
      [
        ...DERIVED_ENV_KEYS,
        ...Object.keys(UNDECLARED_ENV_KEYS),
        ...URL_SHAPED_KEYS,
      ].sort()
    );
  });

  it("omits every key outside the allowlist, whatever it is named", () => {
    const collected = collectEnv({
      ...seededEnv(),
      HARMLESS_LOOKING_KEY: "value",
    });
    expect(Object.keys(collected).sort()).toEqual(
      ENV_ALLOWLIST.filter((key) => key in seededEnv()).sort()
    );
  });

  it("distinguishes a key that is not set from one set to empty", () => {
    const collected = collectEnv({ VECTOR_DB: "" });
    expect(collected).toHaveProperty("VECTOR_DB", "");
    expect(collected).not.toHaveProperty("LLM_PROVIDER");
  });

  it("keeps DATABASE_URL's host and database and drops its password", () => {
    const collected = collectEnv(seededEnv());
    expect(collected.DATABASE_URL).toContain("db.internal:5432");
    expect(collected.DATABASE_URL).toContain("anythingllm");
    expect(collected.DATABASE_URL).not.toContain(SEEDED.dbPassword);
    expect(collected.DATABASE_URL).not.toContain("appuser");
  });

  it("masks a DATABASE_URL that does not parse rather than passing it through", () => {
    const collected = collectEnv({ DATABASE_URL: "not a url at all" });
    expect(collected.DATABASE_URL).toBe("**********");
    expect(collected.DATABASE_URL).not.toContain("not a url");
  });

  it("declares DATABASE_URL as the URL-shaped key it strips", () => {
    expect(URL_SHAPED_KEYS).toContain("DATABASE_URL");
    expect(Object.isFrozen(URL_SHAPED_KEYS)).toBe(true);
    expect(Object.isFrozen(DERIVED_ENV_KEYS)).toBe(true);
    expect(Object.isFrozen(UNDECLARED_ENV_KEYS)).toBe(true);
  });
});

describe("O5b bundle — the database section reports counts, never rows", () => {
  it("counts event_logs without carrying any row content", async () => {
    let sawRowSelect = false;
    const client = {
      query: async (sql) => {
        if (/select\s+.*metadata/i.test(sql)) sawRowSelect = true;
        if (sql.includes("_prisma_migrations")) return { rows: [] };
        if (sql.includes("server_version")) return { rows: [{ server_version: "16.4" }] };
        if (sql.includes("GROUP BY event")) return { rows: [{ event: "login", n: 3 }] };
        return { rows: [{ n: 12 }] };
      },
    };
    const db = await collectDatabase(client);
    expect(sawRowSelect).toBe(false);
    expect(db.counts.event_logs).toBe(12);
    expect(db.eventCounts).toEqual({ login: 3 });
    expect(JSON.stringify(db)).not.toContain("metadata");
  });

  it("counts every declared table", async () => {
    const db = await collectDatabase(seededClient());
    for (const table of COUNTED_TABLES) expect(db.counts[table]).toBe(7);
  });

  it("degrades one failing query into one error row, not a failed bundle", async () => {
    const client = {
      query: async (sql) => {
        if (sql.includes('"users"')) throw new Error('relation "users" does not exist');
        if (sql.includes("_prisma_migrations")) return { rows: [] };
        if (sql.includes("server_version")) return { rows: [{ server_version: "16.4" }] };
        if (sql.includes("GROUP BY event")) return { rows: [] };
        return { rows: [{ n: 1 }] };
      },
    };
    const db = await collectDatabase(client);
    expect(db.counts.users.error).toMatch(/does not exist/);
    expect(db.counts.workspaces).toBe(1);
  });

  it("says the database was unreachable rather than reporting an empty one", async () => {
    const db = await collectDatabase(null);
    expect(db.error).toMatch(/not reachable/);
    expect(db.counts).toBeUndefined();
  });
});

describe("O5b bundle — numbers stay numbers (TL-1 F3a)", () => {
  it("does not stringify resource figures, which would make them PDPA matches", async () => {
    // `String(os.totalmem())` is 11-13 digits on a real machine, so a bundle
    // that stringified before scrubbing would report
    // `"[redacted:thai_national_id]"` for its own memory. `scrubValue` returns
    // non-strings untouched; this holds that, because a future "normalise
    // everything to strings before scrubbing" is a plausible and quiet change.
    const { bundle } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: [],
    });
    expect(typeof bundle.resources.totalMemoryBytes).toBe("number");
    expect(typeof bundle.resources.uptimeSeconds).toBe("number");
    expect(typeof bundle.resources.cpuCount).toBe("number");
    expect(typeof bundle.database.counts.users).toBe("number");
    expect(JSON.stringify(bundle.resources)).not.toContain("[redacted:");
  });
});

describe("O5b bundle — the URL is stripped before it is scrubbed (TL-1 F3b)", () => {
  it("removes the userinfo entirely rather than pattern-matching inside it", () => {
    // Order matters. `stripUrlCredentials` first removes `user:pass@`; only then
    // does `scrubValue` run. Reversing them would leave a `user@host`-shaped
    // string matching the EMAIL pattern, so the bundle would say
    // `[redacted:email]@db.internal` — the password gone but the username and
    // the shape preserved, which reads as redaction while still naming the
    // account.
    const collected = collectEnv(seededEnv());
    expect(collected.DATABASE_URL).toBe(
      "postgresql://db.internal:5432/anythingllm"
    );
    expect(collected.DATABASE_URL).not.toContain("redacted");
    expect(collected.DATABASE_URL).not.toContain("appuser");
  });

  it("keeps no username in the database section's connection line", async () => {
    // TL-1 F4: the doctor's own `maskUrl` keeps the username. A database
    // username and an internal hostname match no PATTERN, so nothing
    // downstream would catch them in a file headed to a public issue.
    const db = await collectDatabase(seededClient(), {
      databaseUrl: seededEnv().DATABASE_URL,
    });
    expect(db.connection).toBe("postgresql://db.internal:5432/anythingllm");
    expect(db.connection).not.toContain("appuser");
    expect(db.connection).not.toContain(SEEDED.dbPassword);
  });
});

describe("O5b bundle — a secret reaching the bundle by PATH, not by mapping (TL-1)", () => {
  // The env allowlist is not the only way in. A doctor check's `detail` string
  // quotes the connection it just made, so a password can arrive inside the
  // CHECKS section, where no allowlist applies. That is the path this covers.
  const password = "pa55word-inside-a-check-detail";
  const url = `postgresql://appuser:${password}@db.internal:5432/anythingllm`;

  it("removes a DATABASE_URL password carried in a check's detail string", async () => {
    const { bundle } = await buildBundle({
      env: { ...seededEnv(), DATABASE_URL: url },
      client: seededClient(),
      checks: [
        {
          id: "db.reachable",
          ok: true,
          level: "block",
          detail: `Connected to ${url}.`,
          remedy: "",
        },
      ],
    });
    const serialised = JSON.stringify(bundle);
    expect(serialised).not.toContain(password);
    // Partial too: a redaction that kept the first eight characters would pass a
    // whole-value assertion and still hand over most of a short password.
    expect(serialised).not.toContain(password.slice(0, 8));
  });
});

/**
 * TL-1 FINDING-1 (#94). The earlier version of the seeded-secret test used
 * `db.internal` as its host, and passed — but only by accident: `scrubValue`'s
 * EMAIL pattern matches `user:pass@db.internal` because that host contains a
 * DOT. The two hosts this project actually ships have none.
 *
 * Both are in the table below, deliberately. Changing the fixture back to a
 * dotted host must not make these pass on their own.
 */
describe("O5b bundle — embedded connection credentials (TL-1 FINDING-1)", () => {
  const PASSWORD = "sup3rsecret-db-password";
  // Punctuation-heavy on purpose: even where the email pattern DID fire it
  // removed only the tail, leaving `Xq7!kR2#mN9$` behind.
  const AWKWARD = "Xq7!kR2#mN9$vL4";

  const HOSTS = [
    ["postgres:5432", "the host in docker/docker-compose.yml"],
    ["localhost:5432", "the host in CI"],
    ["db.internal:5432", "a dotted host — must not be the only one that passes"],
  ];

  describe.each(HOSTS)("host %s (%s)", (host) => {
    it("removes the password from a driver error quoting the connection string", async () => {
      // The LIVE path: safeQuery returns error.message, and pg quotes the
      // connection string on a connection failure — which is the moment
      // someone runs --bundle.
      const client = {
        query: async () => {
          throw new Error(
            `connection to postgresql://appuser:${PASSWORD}@${host}/anythingllm failed`
          );
        },
      };
      const db = await collectDatabase(client, {
        databaseUrl: `postgresql://appuser:${PASSWORD}@${host}/anythingllm`,
      });
      const serialised = JSON.stringify(db);
      expect(serialised).not.toContain(PASSWORD);
      expect(serialised).not.toContain("appuser:");
      // and the host survives, because it is the diagnostic part
      expect(serialised).toContain(host.split(":")[0]);
    });

    it("removes a password carried in a check's detail string", async () => {
      const { bundle } = await buildBundle({
        env: seededEnv(),
        client: seededClient(),
        checks: [
          {
            id: "db.reachable",
            ok: true,
            level: "block",
            detail: `Connected to postgresql://appuser:${PASSWORD}@${host}/anythingllm.`,
            remedy: "",
          },
        ],
      });
      expect(JSON.stringify(bundle)).not.toContain(PASSWORD);
    });

    it("removes an awkward password whole, not just its tail", async () => {
      const text = `error postgresql://appuser:${AWKWARD}@${host}/db refused`;
      const scrubbed = scrubText(text);
      expect(scrubbed).not.toContain(AWKWARD);
      // The specific earlier failure: the email pattern started matching at the
      // last dot-free run, so the leading characters survived.
      expect(scrubbed).not.toContain("Xq7!kR2#mN9$");
      expect(scrubbed).not.toContain("Xq7");
    });
  });

  it("strips EVERY credential run in a string, not just the first", () => {
    const scrubbed = scrubText(
      `primary postgresql://a:${PASSWORD}@postgres:5432/x replica postgresql://b:${AWKWARD}@localhost:5432/y`
    );
    expect(scrubbed).not.toContain(PASSWORD);
    expect(scrubbed).not.toContain(AWKWARD);
    expect(scrubbed).toContain("postgres:5432");
    expect(scrubbed).toContain("localhost:5432");
  });

  it("strips a username with NO password half (QA-2 FINDING-2)", () => {
    // The doctor's own `maskUrl` produces exactly this shape — it replaces the
    // password and KEEPS the username — and it reaches the bundle through
    // `checks[].detail`, a different path from `database.connection`.
    const scrubbed = scrubText(
      "Connected to postgresql://qa2_leak_probe:****@localhost:55451/qa."
    );
    expect(scrubbed).not.toContain("qa2_leak_probe");
    expect(scrubbed).toContain("localhost:55451");

    // And with no password half at all, which the first version let through
    // because its pattern required a `:`.
    const bare = scrubText("postgresql://qa2_leak_probe@postgres:5432/qa");
    expect(bare).not.toContain("qa2_leak_probe");
    expect(bare).toContain("postgres:5432");
  });

  it("redacts the account the pg driver names in prose (QA-2 FINDING-2)", () => {
    // `password authentication failed for user "appuser"` matches no pattern in
    // redaction.js — a database username is neither a secret nor PII, so
    // nothing was ever going to catch it.
    const scrubbed = scrubText(
      'password authentication failed for user "appuser"'
    );
    expect(scrubbed).not.toContain("appuser");
    expect(scrubbed).toContain("[redacted]");
  });

  it("names db_username among the redaction classes", async () => {
    const { redactions } = await buildBundle({
      env: seededEnv(),
      client: seededClient(),
      checks: [
        {
          id: "db.reachable",
          ok: false,
          level: "block",
          detail: 'password authentication failed for user "appuser"',
          remedy: "",
        },
      ],
    });
    expect(redactions).toContain("db_username");
  });

  it("leaves text with no credentials alone", () => {
    // A strip that fires on everything is not a strip.
    expect(scrubText("relation \"users\" does not exist")).toBe(
      'relation "users" does not exist'
    );
    expect(scrubText("postgresql://postgres:5432/anythingllm")).toBe(
      "postgresql://postgres:5432/anythingllm"
    );
  });
});

describe("O5b bundle — no allowlisted key is a declared secret (TL-1 NIT-1)", () => {
  it("keeps REQUIRED_SECRETS and every secret-declared envKey out of UNDECLARED_ENV_KEYS", () => {
    const { REQUIRED_SECRETS } = require("../../../utils/doctor");
    const declaredSecret = Object.values(KEY_MAPPING)
      .filter((entry) => entry.secret === true || entry.secret === "url")
      .map((entry) => entry.envKey);
    const forbidden = new Set([...REQUIRED_SECRETS, ...declaredSecret]);
    const offenders = Object.keys(UNDECLARED_ENV_KEYS).filter((key) =>
      forbidden.has(key)
    );
    expect(offenders).toEqual([]);
  });
});

describe("O5b bundle — invisible characters do not smuggle PII out (#131)", () => {
  // RF-4. The bundle is the artifact deliberately handed to outsiders, so the
  // strip has to hold on THIS path, not only on the audit sink.
  //
  // Measured before the fix, through `scrubText` itself:
  //
  //   "note id 123456<ZWSP>7890123"            unchanged, no hits
  //   "code apw-inv-ABCDEFGH<ZWSP>IJKLMNOP"    unchanged, no hits
  //   "postgresql://ap<ZWSP>puser:s3cret@h/db" already stripped — the bundle's
  //   'failed for user "ap<ZWSP>puser"'        own two regexes match on
  //                                            STRUCTURE, so they survived
  //
  // So the gap was exactly the shared pattern scan, which `scrubText` reaches
  // through `scrubValue`. That means the bundle INHERITS the fix — a fact about
  // today's call graph, not a contract. If someone later gives `scrubText` its
  // own scan, the bundle starts leaking again with every audit-side test still
  // green. These tests are what makes that impossible.
  const INVISIBLE = ["​", "­", "͏", "﻿", "⁠"];

  test.each(INVISIBLE)(
    "a Thai national id split by %j is redacted in the bundle",
    (mark) => {
      const hits = new Set();
      const out = scrubText(`note id 1234567${mark}890123 end`, hits);
      expect(out).not.toContain("890123");
      expect(hits.has("thai_national_id")).toBe(true);
    }
  );

  test.each(INVISIBLE)(
    "a credential split by %j is redacted in the bundle",
    (mark) => {
      const hits = new Set();
      const out = scrubText(`code apw-inv-ABCDEFGH${mark}IJKLMNOP`, hits);
      expect(out).not.toContain("IJKLMNOP");
      expect(hits.has("credential")).toBe(true);
    }
  );

  test("the bundle's OWN regexes were never the gap — they match on structure", () => {
    // Asserted so the recon stays true rather than being remembered. A
    // zero-width character inside the username does not stop either of them,
    // because neither matches on the username's characters.
    const hits = new Set();
    expect(
      scrubText("postgresql://ap​puser:s3cret@localhost/db", hits)
    ).not.toContain("s3cret");
    expect(scrubText('failed for user "ap​puser"', hits)).not.toContain(
      "puser"
    );
  });

  test("legitimate text carrying U+200B still reaches the bundle intact", () => {
    // The bundle is a diagnostic: over-redacting it costs an operator the
    // information they opened it for.
    const text = "workspace​name";
    expect(scrubText(text, new Set())).toBe(text);
  });
});
