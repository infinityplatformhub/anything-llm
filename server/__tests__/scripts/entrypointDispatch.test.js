/* eslint-env jest */

/**
 * O2a (#74) Task 3 — `docker/docker-entrypoint.sh` command dispatch.
 *
 * `docker compose run --rm --no-deps anything-llm doctor` was documented before
 * it existed. The ENTRYPOINT is exec-form with no arguments read, so the word
 * `doctor` was dropped on the floor and the whole server booted instead — which
 * is worse than an error, because the operator reads a booting app as a passing
 * check.
 *
 * The script is bash, so `--findRelatedTests` cannot reach it. These tests run
 * the real file under `bash` with a stub PATH, and assert on exit codes and on
 * which stubs were invoked. Grepping the file for a `case` statement would go
 * green on a dispatch that does not work.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ENTRYPOINT = path.join(__dirname, "../../../docker/docker-entrypoint.sh");

let tempDir;
let binDir;
let traceFile;
let appRoot;

/** A stub that records its argv and exits with the code we ask for. */
function stub(name, exitCode = 0) {
  const file = path.join(binDir, name);
  fs.writeFileSync(
    file,
    `#!/bin/bash\necho "${name} $*" >> "${traceFile}"\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
}

function runEntrypoint(args = [], env = {}) {
  const result = spawnSync("bash", [ENTRYPOINT, ...args], {
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: tempDir,
      APP_ROOT: appRoot,
      STORAGE_DIR: path.join(tempDir, "storage"),
      DATABASE_URL: "postgresql://stub/stub",
      ...env,
    },
    encoding: "utf8",
    timeout: 20000,
  });
  const trace = fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, "utf8")
    : "";
  return { ...result, trace };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-"));
  binDir = path.join(tempDir, "bin");
  appRoot = path.join(tempDir, "app");
  fs.mkdirSync(binDir);
  fs.mkdirSync(path.join(appRoot, "server", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(appRoot, "collector"), { recursive: true });
  fs.mkdirSync(path.join(tempDir, "storage"));
  traceFile = path.join(tempDir, "trace");
  fs.writeFileSync(traceFile, "");
  stub("node");
  stub("npx");
  stub("sleep");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("the dispatch exists at all", () => {
  it("reads its first argument", () => {
    // The regression this whole task starts from: an ENTRYPOINT that ignores
    // "$@" accepts `doctor` and boots the server.
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(source).toMatch(/\$\{1:-/);
  });

  it("uses exec for the doctor arm", () => {
    // Weak on its own — the behavioural test above proves the exit code
    // survives — but it names the ONE word whose removal is invisible in a
    // reading of the file and fatal to the gate.
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(source).toMatch(/exec node .*doctor\.js/);
  });

  it("chains ensure-secrets, doctor and migrate with && rather than ;", () => {
    // A `;` between them would run the migration whatever the doctor said,
    // which is the entire failure this ordering exists to prevent.
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    expect(source).toMatch(/ensure-secrets\.js" &&/);
    expect(source).toMatch(/doctor\.js" &&/);
  });

  it("runs the preflight inside the backgrounded server block, after the cd", () => {
    // Both scripts resolve paths relative to the server directory; hoisting
    // them out of the `{ ... } &` block would run them before `cd` and outside
    // the chain whose failure stops the boot.
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const cdAt = source.indexOf('cd "$APP_ROOT/server/"');
    const secretsAt = source.indexOf("ensure-secrets.js");
    expect(cdAt).toBeGreaterThan(-1);
    expect(secretsAt).toBeGreaterThan(cdAt);
  });

  it("dispatches before the STORAGE_DIR warning (ruling 5)", () => {
    // The warning block is 14 lines of banner. Running it first means
    // `... run --rm anything-llm doctor` prints a storage warning about a
    // container that is not going to serve anything, ahead of the answer the
    // operator asked for.
    // Anchored on the code, not on the word: a comment above the dispatch that
    // mentions STORAGE_DIR would otherwise fail a correctly-ordered script.
    const source = fs.readFileSync(ENTRYPOINT, "utf8");
    const caseAt = source.search(/^case /m);
    const warningAt = source.search(/^if \[ -z "\$STORAGE_DIR" \]/m);
    expect(caseAt).toBeGreaterThan(-1);
    expect(warningAt).toBeGreaterThan(-1);
    expect(caseAt).toBeLessThan(warningAt);
  });
});

describe("doctor", () => {
  it("skips the STORAGE_DIR banner, which the doctor reports better itself", () => {
    // Deliberate (TL-2 OBS-4): the doctor has a storage.writable check that
    // names the actual path and a remedy. Leading with 14 lines of banner
    // about a container that is not going to serve anything buries the answer
    // the operator asked for.
    const result = runEntrypoint(["doctor"], { STORAGE_DIR: "" });
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "STORAGE_DIR environment variable is not set"
    );
  });

  it("runs the doctor script and nothing else", () => {
    const result = runEntrypoint(["doctor"]);
    expect(result.status).toBe(0);
    expect(result.trace).toContain("scripts/doctor.js");
    // The two things a doctor run must NOT do: boot the server, or migrate.
    expect(result.trace).not.toContain("server/index.js");
    expect(result.trace).not.toContain("prisma migrate deploy");
  });

  it("passes the doctor's exit code through", () => {
    // `exec` is what makes this true. Without it the script continues to
    // `wait -n; exit $?` and the doctor's verdict is discarded — the failure
    // mode where the gate reports success because the last command succeeded.
    stub("node", 3);
    const result = runEntrypoint(["doctor"]);
    expect(result.status).toBe(3);
  });

  it("does not wait for the database before answering", () => {
    // depends_on: service_healthy already makes `docker compose run` wait on
    // the bundled postgres. If the entrypoint ALSO polls, an operator
    // diagnosing an unreachable external database watches "Waiting for
    // PostgreSQL..." instead of reading "cannot connect".
    stub("node", 1); // the pg-connect probe would fail and loop forever
    const result = runEntrypoint(["doctor"]);
    expect(result.status).toBe(1);
    expect(result.trace).not.toContain("Waiting for PostgreSQL");
  });
});

describe("serve", () => {
  it("is the default when no argument is given", () => {
    const result = runEntrypoint([]);
    expect(result.trace).toContain("prisma generate");
  });

  it("accepts an explicit serve", () => {
    const result = runEntrypoint(["serve"]);
    expect(result.trace).toContain("prisma generate");
  });

  it("generates secrets, then runs the doctor, then migrates — in that order", () => {
    // Order is not a preference. ensure-secrets must run first or
    // secrets.present fails on a fresh install; the doctor must run before
    // `migrate deploy`, because a CREATE EXTENSION that fails leaves the
    // database in a failed-migration state that blocks every later migration
    // (§7.13). After the migration it is a post-mortem.
    const result = runEntrypoint([]);
    const secretsAt = result.trace.indexOf("ensure-secrets.js");
    const doctorAt = result.trace.indexOf("doctor.js");
    const migrateAt = result.trace.indexOf("migrate deploy");
    expect(secretsAt).toBeGreaterThan(-1);
    expect(doctorAt).toBeGreaterThan(secretsAt);
    expect(migrateAt).toBeGreaterThan(doctorAt);
  });

  it("does not start the server when the doctor blocks", () => {
    // A blocking failure must stop the boot, not warn and continue.
    const failingDoctor = path.join(binDir, "node");
    fs.writeFileSync(
      failingDoctor,
      `#!/bin/bash
echo "node $*" >> "${traceFile}"
case "$*" in *doctor.js*) exit 1 ;; esac
exit 0
`,
      { mode: 0o755 }
    );
    const result = runEntrypoint([]);
    expect(result.trace).not.toContain("server/index.js");
  });
});

describe("an unknown command", () => {
  it("is refused rather than silently treated as serve", () => {
    // The failure that started this: an unrecognised argument that boots the
    // server anyway teaches the operator that their command worked.
    const result = runEntrypoint(["dcotor"]);
    expect(result.status).not.toBe(0);
    expect(result.trace).not.toContain("server/index.js");
  });

  it("names the command it did not recognise", () => {
    const result = runEntrypoint(["dcotor"]);
    expect(`${result.stdout}${result.stderr}`).toContain("dcotor");
  });
});
