/* eslint-env jest */

/**
 * O5b (#94) — `doctor --bundle` at the command line.
 *
 * The contract an operator relies on is a REDIRECT:
 *
 *   docker compose run --rm anything-llm doctor --bundle > bundle.json
 *
 * so the whole of stdout must be JSON. Every assertion below parses the entire
 * stream rather than searching it for a `{` — a stray `console.log` from any
 * module the doctor loads would still pass a "contains JSON" test and still
 * produce a file that does not parse.
 *
 * The database-backed paths need a PostgreSQL at DATABASE_URL; they are skipped
 * without one, exactly like doctor.test.js. The argument handling and the
 * entrypoint's forwarding do not, and run everywhere.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.join(__dirname, "../../scripts/doctor.js");
const ENTRYPOINT = path.join(__dirname, "../../../docker/docker-entrypoint.sh");
const withDb = process.env.DATABASE_URL?.startsWith("postgres")
  ? describe
  : describe.skip;

let tempDir;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cli-"));
  fs.mkdirSync(path.join(tempDir, "storage"));
  fs.writeFileSync(
    path.join(tempDir, ".env"),
    "JWT_SECRET=a\nSIG_KEY=b\nSIG_SALT=c\nAPI_KEY_PEPPER=d\n",
    { mode: 0o600 }
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const runDoctor = (args = [], extraEnv = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    env: {
      ...process.env,
      ENV_FILE_PATH: path.join(tempDir, ".env"),
      STORAGE_DIR: path.join(tempDir, "storage"),
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 60000,
  });

/** A stub `node` that records its argv, so the entrypoint tests are behavioural. */
function stubTree(suffix) {
  const binDir = path.join(tempDir, `bin${suffix}`);
  const appRoot = path.join(tempDir, `app${suffix}`);
  const traceFile = path.join(tempDir, `trace${suffix}`);
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(appRoot, "server", "scripts"), { recursive: true });
  fs.writeFileSync(traceFile, "");
  fs.writeFileSync(
    path.join(binDir, "node"),
    ["#!/bin/bash", `echo "node $*" >> "${traceFile}"`, "exit 0", ""].join("\n"),
    { mode: 0o755 }
  );
  return { binDir, appRoot, traceFile };
}

const runEntrypoint = (args, { binDir, appRoot }) =>
  spawnSync("bash", [ENTRYPOINT, ...args], {
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: tempDir,
      APP_ROOT: appRoot,
      STORAGE_DIR: path.join(tempDir, "storage"),
      DATABASE_URL: "postgresql://stub/stub",
    },
    encoding: "utf8",
    timeout: 20000,
  });

describe("doctor --bundle argument handling", () => {
  it("rejects an unknown option instead of silently running the checklist", () => {
    const run = runDoctor(["--bunlde"]);
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("--bunlde");
    expect(run.stdout).toBe("");
  });
});

withDb("doctor --bundle against a database", () => {
  it("puts JSON and nothing else on stdout, so the redirect produces a parseable file", () => {
    const run = runDoctor(["--bundle"]);
    // The assertion is on the WHOLE stream. JSON.parse throws on any leading or
    // trailing line, which is the failure a `toContain("{")` would let through.
    const parsed = JSON.parse(run.stdout);
    expect(parsed).toHaveProperty("generatedAt");
    expect(parsed).toHaveProperty("versions.node", process.version);
    expect(parsed).toHaveProperty("environment");
    expect(parsed).toHaveProperty("database");
  });

  it("puts the human checklist on stderr, where the redirect does not capture it", () => {
    const run = runDoctor(["--bundle"]);
    expect(run.stderr).toMatch(/\[(PASS|FAIL|WARN)\] db\.reachable/);
    expect(run.stdout).not.toMatch(/\[(PASS|FAIL|WARN)\]/);
  });

  it("carries the doctor's checklist inside the bundle, so one paste answers the preflight questions", () => {
    const parsed = JSON.parse(runDoctor(["--bundle"]).stdout);
    const ids = parsed.checks.map((check) => check.id);
    expect(ids).toContain("db.reachable");
    expect(ids).toContain("secrets.present");
  });

  it("reports no DATABASE_URL password anywhere in the file", () => {
    const url = new URL(process.env.DATABASE_URL);
    const raw = runDoctor(["--bundle"]).stdout;
    const password = url.password || "approof-absent-sentinel";
    expect(raw).not.toContain(`:${password}@`);
    expect(JSON.parse(raw).environment.DATABASE_URL).toContain(url.host);
  });

  it("leaves the plain checklist on stdout when --bundle is absent", () => {
    const run = runDoctor([]);
    expect(run.stdout).toMatch(/\[(PASS|FAIL|WARN)\] db\.reachable/);
    expect(() => JSON.parse(run.stdout)).toThrow();
  });

  it("exits on the CHECKS, not on whether bundling worked", () => {
    // A bundle assembled from a broken install is a successful bundling of a
    // failing install; the operator needs the failure in $?.
    const good = runDoctor(["--bundle"]);
    const bad = runDoctor(["--bundle"], {
      DATABASE_URL: "postgresql://nobody@127.0.0.1:1/none",
    });
    expect(good.status).toBe(0);
    expect(bad.status).toBe(1);
    // Still a whole, parseable bundle — an unreachable database is exactly when
    // someone runs this.
    expect(JSON.parse(bad.stdout).database.error).toBeDefined();
  });
});

describe("the entrypoint forwards the doctor's own flags", () => {
  it("passes --bundle through instead of dropping it", () => {
    const tree = stubTree("A");
    const run = runEntrypoint(["doctor", "--bundle"], tree);
    expect(run.status).toBe(0);
    expect(fs.readFileSync(tree.traceFile, "utf8")).toMatch(
      /doctor\.js --bundle/
    );
  });

  it("still runs the plain checklist for bare `doctor`", () => {
    const tree = stubTree("B");
    runEntrypoint(["doctor"], tree);
    const trace = fs.readFileSync(tree.traceFile, "utf8");
    expect(trace).toMatch(/doctor\.js\s*$/m);
    expect(trace).not.toMatch(/--/);
  });
});
