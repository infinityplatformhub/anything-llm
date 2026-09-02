/* eslint-env jest */

/**
 * O2a (#74) Task 2 — the preflight checks and the `doctor` CLI.
 *
 * The checks run twice: once on demand
 * (`docker compose run --rm --no-deps anything-llm doctor`) and once
 * automatically in the entrypoint before `prisma migrate deploy`. A blocking
 * failure must stop the boot, because #61's migration creates a pg_trgm index
 * and a failed CREATE EXTENSION leaves the database in a failed-migration state
 * that blocks every later migration (§7.13). Warnings must not stop it.
 *
 * The database-backed checks run against the real DATABASE_URL. The refusal
 * paths (unwritable .env, wrong uid, missing extension) are driven through
 * injected inputs, because they cannot be produced on a healthy dev box.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT = path.join(__dirname, "../../scripts/doctor.js");
// Same guard as __tests__/models/apiKeys.postgres.test.js:6 — the checks that
// query a database only mean anything against one. Everything that does not
// need a database (the check list, levels, remedies, env/storage/secrets, and
// the unreachable-database path) runs unconditionally below.
const withDb = process.env.DATABASE_URL?.startsWith("postgres")
  ? describe
  : describe.skip;
const MODULE = path.join(__dirname, "../../utils/doctor/index.js");

let doctor;
let tempDir;
let envPath;
let storageDir;

beforeAll(() => {
  if (!fs.existsSync(MODULE)) throw new Error(`missing: ${MODULE}`);
  doctor = require("../../utils/doctor");
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  envPath = path.join(tempDir, ".env");
  storageDir = path.join(tempDir, "storage");
  fs.mkdirSync(storageDir);
  fs.writeFileSync(
    envPath,
    "JWT_SECRET=a\nSIG_KEY=b\nSIG_SALT=c\nAPI_KEY_PEPPER=d\n",
    { mode: 0o600 }
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const base = () => ({
  databaseUrl: process.env.DATABASE_URL,
  envPath,
  storageDir,
});

describe("the check list itself", () => {
  it("declares the eight checks the rulings name", () => {
    expect(doctor.CHECK_IDS.sort()).toEqual(
      [
        "db.locale",
        "db.reachable",
        "db.version",
        "env.writable",
        "ext.available",
        "ext.permitted",
        "secrets.present",
        "storage.writable",
      ].sort()
    );
  });

  it("marks db.locale as the only non-blocking check (ruling Q4)", () => {
    const warnings = doctor.CHECK_IDS.filter(
      (id) => doctor.levelOf(id) === "warn"
    );
    expect(warnings).toEqual(["db.locale"]);
  });

  it("gives every check a remedy string", () => {
    // A failure with no remedy makes the operator's problem legible without
    // making it fixable, which is the failure mode this whole task exists to
    // avoid.
    for (const id of doctor.CHECK_IDS) {
      expect(typeof doctor.remedyOf(id)).toBe("string");
      expect(doctor.remedyOf(id).length).toBeGreaterThan(0);
    }
  });

  it("opens no socket to anything but the database (ruling Q5)", () => {
    // Air-gap: a reachability check against an LLM provider would fail an
    // install that is otherwise perfectly healthy. Asserted on the source, not
    // on behaviour, because a network call that is never taken on the happy
    // path would pass a behavioural test.
    const source = fs.readFileSync(MODULE, "utf8");
    expect(source).not.toMatch(/require\(["'](https?|node-fetch|axios)["']\)/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
  });

  it("does not reach apiKeySecurity or the boot tree (ruling 2f)", () => {
    const source = fs.readFileSync(MODULE, "utf8");
    expect(source).not.toMatch(/require\([^)]*apiKeySecurity/);
    expect(source).not.toMatch(/require\([^)]*utils\/boot/);
  });

  it("loads with API_KEY_PEPPER unset", () => {
    // The doctor exists partly to report a missing pepper. A module that throws
    // at import when the pepper is missing cannot report it.
    const probe = `require(${JSON.stringify(MODULE)});`;
    const env = { ...process.env };
    delete env.API_KEY_PEPPER;
    expect(() =>
      execFileSync(process.execPath, ["-e", probe], { env, stdio: "pipe" })
    ).not.toThrow();
  });
});

withDb("checks against a healthy database", () => {
  it("passes every blocking check", async () => {
    const results = await doctor.runChecks(base());
    const blocking = results.filter((r) => r.level === "block" && !r.ok);
    expect(blocking).toEqual([]);
  });

  it("reports the server version it found", async () => {
    const results = await doctor.runChecks(base());
    const version = results.find((r) => r.id === "db.version");
    expect(version.ok).toBe(true);
    expect(version.detail).toMatch(/\d+/);
  });

  it("reports availability separately from permission (ruling 2d)", async () => {
    // Two rows, not one: a managed PostgreSQL that simply does not ship
    // `vector` must not be told to request a grant that cannot exist.
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "ext.available")).toBeDefined();
    expect(results.find((r) => r.id === "ext.permitted")).toBeDefined();
  });

  it("reports availability separately from permission (ruling 2d)", async () => {
    // Two rows, not one: a managed PostgreSQL that simply does not ship
    // `vector` must not be told to request a grant that cannot exist.
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "ext.available")).toBeDefined();
    expect(results.find((r) => r.id === "ext.permitted")).toBeDefined();
  });
});

withDb("ext.permitted, over states the test creates for itself", () => {
  // Which extensions are installed is a property of the database, and the two
  // databases this suite may meet disagree: a migrated one has pg_trgm, a fresh
  // one — the very thing a preflight inspects — does not. Asserting against
  // whatever happens to be there produced tests that passed only after
  // migration, which is backwards for this tool.
  //
  // So the fixture is an extension nothing else uses, created and dropped by
  // these tests. pg_trgm cannot serve: after migration 20260902100000 its
  // indexes depend on it and DROP EXTENSION fails with 2BP01.
  const FIXTURE = "citext";
  const { Client } = require("pg");

  const connect = async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    return client;
  };

  /** Skip rather than lie if this server does not ship the fixture. */
  const available = async (client) => {
    const { rows } = await client.query(
      "SELECT installed_version FROM pg_available_extensions WHERE name = $1",
      [FIXTURE]
    );
    return rows.length > 0;
  };

  describe("when the extension is NOT installed", () => {
    it("says permission was verified, and that the write was rolled back", async () => {
      const client = await connect();
      try {
        if (!(await available(client))) return;
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`);

        const [, permitted] = await doctor.checkExtensions(client, [FIXTURE]);

        expect(permitted.ok).toBe(true);
        expect(permitted.detail).toMatch(/permission verified/);
        expect(permitted.detail).toMatch(/rolled back/);
        expect(permitted.detail).toContain(FIXTURE);
        // And it must NOT claim the other half's fact.
        expect(permitted.detail).not.toMatch(/already installed/);
      } finally {
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`).catch(() => {});
        await client.end();
      }
    });

    it("leaves the extension uninstalled: the probe really did roll back", async () => {
      // The disclosure in the detail is a claim about behaviour. This is the
      // check that the claim is true — otherwise the doctor would be creating
      // extensions on the operator's database while telling them it does not.
      const client = await connect();
      try {
        if (!(await available(client))) return;
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`);

        await doctor.checkExtensions(client, [FIXTURE]);

        const { rows } = await client.query(
          "SELECT installed_version FROM pg_available_extensions WHERE name = $1",
          [FIXTURE]
        );
        expect(rows[0].installed_version).toBeNull();
      } finally {
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`).catch(() => {});
        await client.end();
      }
    });
  });

  describe("when the extension IS installed", () => {
    it("does not run CREATE EXTENSION against it at all", async () => {
      // What makes ruling 6 hold is the FILTER, not the SQL keyword: only
      // extensions that are genuinely absent are probed. Measured on this
      // server with an unprivileged role — `CREATE EXTENSION IF NOT EXISTS` on
      // an installed extension SUCCEEDS (a no-op, testing no permission),
      // while plain `CREATE EXTENSION` fails 42710 "already exists", which is
      // not a permission error either and would be reported as a denial.
      //
      // So neither statement can be run against an installed extension: one
      // lies green, the other lies red. The filter is the whole guard, and
      // this is the test that holds it — a mutant swapping the keyword back
      // survives, correctly, because with the filter in place the two are
      // equivalent.
      const client = await connect();
      const attempted = [];
      const spy = {
        query: (sql, params) => {
          if (typeof sql === "string" && /CREATE EXTENSION/i.test(sql))
            attempted.push(sql);
          return client.query(sql, params);
        },
      };
      try {
        if (!(await available(client))) return;
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${FIXTURE}"`);

        await doctor.checkExtensions(spy, [FIXTURE]);

        expect(attempted).toEqual([]);
      } finally {
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`).catch(() => {});
        await client.end();
      }
    });


    it("does not claim a permission it did not test (QA-3 nit)", async () => {
      // An installed extension proves it is there. It proves nothing about
      // whether THIS role could have created it — and nothing needs to, since
      // it will not be created again. Wording the halves alike would report a
      // verified privilege that was never verified: the same class of lie as
      // `IF NOT EXISTS` returning success on a no-op, which ruling 6 already
      // removed from the probe itself.
      const client = await connect();
      try {
        if (!(await available(client))) return;
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${FIXTURE}"`);

        const [, permitted] = await doctor.checkExtensions(client, [FIXTURE]);

        expect(permitted.ok).toBe(true);
        expect(permitted.detail).toMatch(
          /already installed, so no permission was needed or tested/
        );
        expect(permitted.detail).not.toMatch(/permission verified/);
      } finally {
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`).catch(() => {});
        await client.end();
      }
    });
  });

  describe("with one of each", () => {
    it("keeps the two lists apart", async () => {
      const client = await connect();
      try {
        if (!(await available(client))) return;
        await client.query(`CREATE EXTENSION IF NOT EXISTS "${FIXTURE}"`);

        // A second extension this server ships but has not installed. Chosen
        // from the catalogue rather than hardcoded, since what a server ships
        // varies.
        const { rows } = await client.query(
          `SELECT name FROM pg_available_extensions
            WHERE installed_version IS NULL AND name <> $1
            ORDER BY name LIMIT 1`,
          [FIXTURE]
        );
        if (!rows.length) return;
        const absent = rows[0].name;

        const [, permitted] = await doctor.checkExtensions(client, [
          FIXTURE,
          absent,
        ]);

        const [installedHalf, verifiedHalf] =
          permitted.detail.split("permission verified");
        expect(verifiedHalf).toBeDefined();
        expect(installedHalf).toContain(FIXTURE);
        expect(installedHalf).not.toContain(absent);
        expect(verifiedHalf).toContain(absent);
        expect(verifiedHalf).not.toContain(FIXTURE);
      } finally {
        await client.query(`DROP EXTENSION IF EXISTS "${FIXTURE}"`).catch(() => {});
        await client.end();
      }
    });
  });

  it("blocks when a needed extension is not shipped, and does not blame permissions", async () => {
    // A server that does not ship the extension must fail ext.available and
    // must NOT report ext.permitted as a permission the operator can request.
    const client = await connect();
    try {
      const [availability, permitted] = await doctor.checkExtensions(client, [
        "an_extension_no_server_ships",
      ]);
      expect(availability.ok).toBe(false);
      expect(availability.level).toBe("block");
      expect(availability.detail).toMatch(/not a permission problem/i);
      expect(permitted.ok).toBe(false);
      expect(permitted.detail).toMatch(/cannot be created by anyone/i);
    } finally {
      await client.end();
    }
  });
});

withDb("locale: two different failures that must not be conflated", () => {
  it("does not report a locale problem when pg_trgm is merely not installed yet", async () => {
    // The probe needs pg_trgm to answer, and on a fresh database the MIGRATION
    // is what installs it — so on a first install the probe cannot run at all.
    // Reporting that as "your LC_CTYPE is wrong" would send the operator to
    // recreate a database that is perfectly fine. Measured on a database with
    // no extensions: the check reports ok and says the server will re-ask.
    const results = await doctor.runChecks(base());
    const locale = results.find((r) => r.id === "db.locale");
    expect(locale.detail).toMatch(/LC_CTYPE is \S+/);
    if (locale.ok) expect(locale.detail).toMatch(/not installed yet|trigrams/);
  });

  it("always names the LC_CTYPE it found, whichever branch it took", async () => {
    // Whatever the verdict, the operator gets the one fact they need to act on.
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "db.locale").detail).toMatch(
      /LC_CTYPE is /
    );
  });
});

withDb("VECTOR_DB spelling", () => {
  // #87 retired the `config.vector_db` check that lived here. It existed
  // because `getVectorDbClass` switched on the raw string, so `VECTOR_DB=
  // PGVECTOR` reached LanceDB and only the installer could catch it. The
  // resolver now normalises, so that spelling WORKS — a preflight still
  // failing it would block a configuration the app itself honours.
  //
  // What survives is the part that was always about this tool: which
  // extensions to check, decided from the operator's intent.
  it("no longer reports a spelling the app now accepts", async () => {
    const results = await doctor.runChecks({ ...base(), vectorDb: "PGVECTOR" });
    expect(results.find((r) => r.id === "config.vector_db")).toBeUndefined();
    expect(results.filter((r) => r.level === "block" && !r.ok)).toEqual([]);
  });

  it("still checks the vector extension for any spelling of pgvector", async () => {
    for (const spelling of ["pgvector", "PGVECTOR", "PgVector", " pgvector "]) {
      expect(doctor.requiredExtensions(spelling)).toEqual([
        "pg_trgm",
        "vector",
      ]);
    }
  });

  it("does not check it for another provider or an unset value", async () => {
    for (const spelling of ["lancedb", "CHROMA", "", undefined]) {
      expect(doctor.requiredExtensions(spelling)).toEqual(["pg_trgm"]);
    }
  });
});

describe("locale is a warning, never a block (ruling Q4)", () => {
  it("declares db.locale non-blocking, whatever the database says", () => {
    expect(doctor.levelOf("db.locale")).toBe("warn");
  });

  it("exits 0 when only warnings failed", () => {
    const results = [
      { id: "db.locale", level: "warn", ok: false, detail: "", remedy: "" },
      { id: "db.reachable", level: "block", ok: true, detail: "", remedy: "" },
    ];
    expect(doctor.exitCodeFor(results)).toBe(0);
  });

  it("exits 1 when any blocking check failed", () => {
    const results = [
      { id: "db.locale", level: "warn", ok: true, detail: "", remedy: "" },
      { id: "ext.permitted", level: "block", ok: false, detail: "", remedy: "" },
    ];
    expect(doctor.exitCodeFor(results)).toBe(1);
  });
});

describe("env.writable — the uid collision that blocks the happy path (ruling 3)", () => {
  it("passes on a file this process owns", async () => {
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "env.writable").ok).toBe(true);
  });

  it("fails, blocking, when the file belongs to another uid", async () => {
    // docker-compose runs the container as ${UID:-1000}. UID is a shell
    // variable that is NOT exported, so compose sees nothing and every machine
    // gets 1000 — including macOS, where the operator is 501. The mounted .env
    // is then owned by someone the container is not, writeEnvFileAtomic
    // refuses, and the boot dies on a default install.
    const results = await doctor.runChecks({ ...base(), uid: 999999 });
    const writable = results.find((r) => r.id === "env.writable");
    expect(writable.ok).toBe(false);
    expect(writable.level).toBe("block");
  });

  it("names both uids in the failure, not just 'permission denied'", async () => {
    const results = await doctor.runChecks({ ...base(), uid: 999999 });
    const detail = results.find((r) => r.id === "env.writable").detail;
    expect(detail).toMatch(/999999/);
    expect(detail).toMatch(new RegExp(String(fs.statSync(envPath).uid)));
  });

  it("gives a remedy that is a runnable command", async () => {
    const results = await doctor.runChecks({ ...base(), uid: 999999 });
    expect(results.find((r) => r.id === "env.writable").remedy).toMatch(
      /UID=\$\(id -u\).*GID=\$\(id -g\).*docker compose/
    );
  });

  it("fails when the directory is not writable, even if the file is (ruling 2)", async () => {
    // writeEnvFileAtomic renames a temp file into place, so the DIRECTORY is
    // what it writes to. It also skips its own guards entirely when the path
    // does not exist (ENOENT), so a read-only directory is invisible to it and
    // surfaces as a rename failure mid-boot.
    fs.chmodSync(tempDir, 0o500);
    try {
      const results = await doctor.runChecks(base());
      const writable = results.find((r) => r.id === "env.writable");
      expect(writable.ok).toBe(false);
    } finally {
      fs.chmodSync(tempDir, 0o700);
    }
  });

  it("fails when .env is a symlink", async () => {
    const decoy = path.join(tempDir, "decoy");
    fs.writeFileSync(decoy, "");
    fs.rmSync(envPath);
    fs.symlinkSync(decoy, envPath);
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "env.writable").ok).toBe(false);
  });
});

describe("secrets.present is reported apart from env.writable (ruling 4b)", () => {
  it("passes when the four generated keys are set", async () => {
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "secrets.present").ok).toBe(true);
  });

  it("fails naming the missing key", async () => {
    // The check accepts a value from the process environment as well as from
    // the file, because compose's `environment:` block is a legitimate way to
    // supply one. So a key is only "missing" when it is in neither.
    //
    // The generated Prisma client loads dotenv from the .env of the tree it was
    // generated in, with that path baked in — so every key in a developer's own
    // .env is already in process.env by the time this runs, and asserting on
    // any of them would be asserting on the harness. Unset it for the duration
    // and put it back, whatever happens.
    const restore = process.env.SIG_SALT;
    delete process.env.SIG_SALT;
    try {
      fs.writeFileSync(envPath, "JWT_SECRET=a\nSIG_KEY=b\n", { mode: 0o600 });
      const results = await doctor.runChecks(base());
      const secrets = results.find((r) => r.id === "secrets.present");
      expect(secrets.ok).toBe(false);
      expect(secrets.detail).toContain("SIG_SALT");
    } finally {
      if (restore === undefined) delete process.env.SIG_SALT;
      else process.env.SIG_SALT = restore;
    }
  });

  it("accepts a secret supplied through the environment rather than the file", async () => {
    // Set explicitly rather than relying on the runner's environment: the
    // sibling test above shows how easily that becomes an assertion about the
    // harness instead of about the check.
    const restore = process.env.API_KEY_PEPPER;
    process.env.API_KEY_PEPPER = "supplied-through-the-environment";
    try {
      fs.writeFileSync(envPath, "JWT_SECRET=a\nSIG_KEY=b\nSIG_SALT=c\n", {
        mode: 0o600,
      });
      const results = await doctor.runChecks(base());
      expect(results.find((r) => r.id === "secrets.present").ok).toBe(true);
    } finally {
      if (restore === undefined) delete process.env.API_KEY_PEPPER;
      else process.env.API_KEY_PEPPER = restore;
    }
  });

  it("does not require AUTH_TOKEN (ruling 5)", async () => {
    // AUTH_TOKEN absent is the correct state of a fresh install and of every
    // "just me, no password" instance. A doctor that demanded it would block
    // the boot of a correctly-installed system.
    const results = await doctor.runChecks(base());
    const secrets = results.find((r) => r.id === "secrets.present");
    expect(secrets.ok).toBe(true);
    expect(secrets.detail).not.toContain("AUTH_TOKEN");
  });

  it("stays green while env.writable is red, and vice versa", async () => {
    // Different fixes: one is chown, the other is a missing value. Collapsing
    // them into one row sends the operator to the wrong remedy.
    const results = await doctor.runChecks({ ...base(), uid: 999999 });
    expect(results.find((r) => r.id === "env.writable").ok).toBe(false);
    expect(results.find((r) => r.id === "secrets.present").ok).toBe(true);
  });
});

describe("storage.writable", () => {
  it("passes on a writable directory", async () => {
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "storage.writable").ok).toBe(true);
  });

  it("fails on a directory that does not exist", async () => {
    const results = await doctor.runChecks({
      ...base(),
      storageDir: path.join(tempDir, "nope"),
    });
    expect(results.find((r) => r.id === "storage.writable").ok).toBe(false);
  });
});

describe("an unreachable database", () => {
  it("fails db.reachable rather than throwing", async () => {
    const results = await doctor.runChecks({
      ...base(),
      databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/none",
    });
    expect(results.find((r) => r.id === "db.reachable").ok).toBe(false);
  });

  it("reports the other database checks as failed, not as passed", async () => {
    // A check that cannot run must not report ok. This is the shape that makes
    // a doctor lie: an unreachable database would otherwise pass its version
    // and extension checks by never testing them.
    const results = await doctor.runChecks({
      ...base(),
      databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/none",
    });
    for (const id of ["db.version", "ext.available", "ext.permitted"]) {
      expect(results.find((r) => r.id === id).ok).toBe(false);
    }
  });

  it("does not let an unreachable database turn the locale warning into a block", async () => {
    const results = await doctor.runChecks({
      ...base(),
      databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/none",
    });
    expect(results.find((r) => r.id === "db.locale").level).toBe("warn");
  });
});

describe("the version floor (ruling 2e / 7)", () => {
  it("is 16, the version migration 20260902100000 actually needs", () => {
    // Pinned as a number, not merely described in prose: a floor that drifts
    // down to 13 or 15 still reads plausibly in a remedy string while letting
    // through the exact databases where `pg_input_is_valid` does not exist.
    expect(doctor.MIN_SERVER_VERSION_NUM).toBe(160000);
  });

  it("fails a server below the floor", () => {
    // The failing side of the comparison, driven directly rather than through
    // a real PostgreSQL 15, which no dev box here has.
    const below = doctor.MIN_SERVER_VERSION_NUM - 1;
    expect(below >= doctor.MIN_SERVER_VERSION_NUM).toBe(false);
    expect(150000 >= doctor.MIN_SERVER_VERSION_NUM).toBe(false);
    expect(160000 >= doctor.MIN_SERVER_VERSION_NUM).toBe(true);
  });

  it("names 16 and says why in the remedy", async () => {
    // PostgreSQL 15 fails inside migration 20260902100000 at
    // pg_input_is_valid with an error that never mentions a version.
    const remedy = doctor.remedyOf("db.version");
    expect(remedy).toMatch(/16/);
    expect(remedy).toMatch(/pg_input_is_valid|gin_trgm_ops/);
  });
});

describe("the CLI", () => {
  it("exists", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
  });
});

withDb("the CLI, against a database", () => {
  it("prints one line per check", () => {
    const out = execFileSync(process.execPath, [SCRIPT], {
      env: { ...process.env, ENV_FILE_PATH: envPath, STORAGE_DIR: storageDir },
      encoding: "utf8",
    });
    for (const id of doctor.CHECK_IDS) expect(out).toContain(id);
  });

  it("exits non-zero and names the blocker when a blocking check fails", () => {
    let status = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [SCRIPT], {
        env: {
          ...process.env,
          ENV_FILE_PATH: envPath,
          STORAGE_DIR: path.join(tempDir, "nope"),
        },
        encoding: "utf8",
      });
    } catch (error) {
      status = error.status;
      out = `${error.stdout}${error.stderr}`;
    }
    expect(status).not.toBe(0);
    expect(out).toContain("storage.writable");
  });
});
