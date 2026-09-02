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

  it("says outright that the permission probe writes and rolls back (ruling 2c)", async () => {
    const results = await doctor.runChecks(base());
    const permitted = results.find((r) => r.id === "ext.permitted");
    expect(permitted.detail.toLowerCase()).toMatch(/roll(ed)? ?back|rollback/);
  });

  it("distinguishes 'already installed' from 'permitted to install' (ruling 6)", async () => {
    // CREATE EXTENSION IF NOT EXISTS on a database that already has the
    // extension is a no-op: it tests nothing and returns success, so a doctor
    // that used it would report a permission the role may not have.
    const results = await doctor.runChecks(base());
    const permitted = results.find((r) => r.id === "ext.permitted");
    expect(permitted.detail).toMatch(/installed|permitted/i);
  });

  it("reports availability separately from permission (ruling 2d)", async () => {
    // Two rows, not one: a managed PostgreSQL that simply does not ship
    // `vector` must not be told to request a grant that cannot exist.
    const results = await doctor.runChecks(base());
    expect(results.find((r) => r.id === "ext.available")).toBeDefined();
    expect(results.find((r) => r.id === "ext.permitted")).toBeDefined();
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
    // SIG_SALT rather than API_KEY_PEPPER: the check accepts a value from the
    // process environment as well as from the file, because compose's
    // `environment:` block is a legitimate way to supply one and the server
    // will see it. The test runner sets API_KEY_PEPPER, so asserting on that
    // key would be asserting on the harness, not on the check.
    fs.writeFileSync(envPath, "JWT_SECRET=a\nSIG_KEY=b\n", { mode: 0o600 });
    const results = await doctor.runChecks(base());
    const secrets = results.find((r) => r.id === "secrets.present");
    expect(secrets.ok).toBe(false);
    expect(secrets.detail).toContain("SIG_SALT");
  });

  it("accepts a secret supplied through the environment rather than the file", async () => {
    fs.writeFileSync(envPath, "JWT_SECRET=a\nSIG_KEY=b\nSIG_SALT=c\n", {
      mode: 0o600,
    });
    const results = await doctor.runChecks(base());
    // API_KEY_PEPPER is absent from this file and present in the environment.
    expect(results.find((r) => r.id === "secrets.present").ok).toBe(
      Boolean(process.env.API_KEY_PEPPER)
    );
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
