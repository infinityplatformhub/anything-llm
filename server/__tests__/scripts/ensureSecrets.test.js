/* eslint-env jest */

/**
 * O2a (#74) Task 1 — `scripts/ensure-secrets.js`.
 *
 * The installer generates the instance secrets before Node boots, because
 * `API_KEY_PEPPER` throws at *import* (utils/apiKeySecurity/index.js:7-9), so
 * anything running inside the server process is already too late.
 *
 * Four properties, each of which has a way of failing that looks like success:
 *  - it generates only the four MACHINE secrets. AUTH_TOKEN is the operator's
 *    single-user password (docker/.env.example:405), not a machine secret;
 *    writing a random value there locks the owner out permanently.
 *  - it never overwrites a value that is already set.
 *  - it fails the boot when writeEnvFileAtomic REFUSES, which it signals by
 *    returning false rather than throwing.
 *  - it loads with API_KEY_PEPPER unset, since that is the case it exists for.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const SCRIPT = path.join(__dirname, "../../scripts/ensure-secrets.js");
const GENERATED = ["JWT_SECRET", "SIG_KEY", "SIG_SALT", "API_KEY_PEPPER"];

let tempDir;
let envPath;

/**
 * Run the script as the entrypoint does: a separate process, own env.
 *
 * The existence check is not ceremony. Three of the assertions below are
 * satisfied by a MISSING script — "exits non-zero", "prints no success", "the
 * second run generates nothing" are all true of a file that is not there — so
 * without this the suite would report partial green while nothing exists at
 * all (§7.9: red for the right reason).
 */
function run(extraEnv = {}) {
  if (!fs.existsSync(SCRIPT)) throw new Error(`missing: ${SCRIPT}`);
  const env = { ...process.env, ENV_FILE_PATH: envPath, ...extraEnv };
  delete env.API_KEY_PEPPER;
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

function parseEnv(body) {
  const out = {};
  for (const line of body.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return out;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensure-secrets-"));
  envPath = path.join(tempDir, ".env");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("ensure-secrets: what it generates", () => {
  it("writes all four machine secrets when the file does not exist", () => {
    const result = run();
    expect(result.status).toBe(0);
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    for (const key of GENERATED) expect(written[key]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never writes AUTH_TOKEN, even though it is absent", () => {
    // Ruling (5). AUTH_TOKEN set to a value nobody has seen makes
    // validatedRequest leave its passthrough branch (validatedRequest.js:29-36)
    // and /system/request-token compare the operator's password against 32
    // random bytes (system.js:400-405) — no password can ever succeed, and the
    // reset path is editing the file the installer just wrote.
    run();
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(written).not.toHaveProperty("AUTH_TOKEN");
    expect(fs.readFileSync(envPath, "utf8")).not.toMatch(/AUTH_TOKEN/);
  });

  it("gives API_KEY_PEPPER at least the 32 bytes apiKeySecurity demands", () => {
    // apiKeySecurity/index.js:9 throws below 32. Asserted on the value rather
    // than on the randomBytes argument, because the encoding is what decides it.
    run();
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(Buffer.byteLength(written.API_KEY_PEPPER, "utf8")).toBeGreaterThanOrEqual(32);
  });

  it("gives every generated key a distinct value", () => {
    // One randomBytes call reused across the four keys would make SIG_KEY and
    // SIG_SALT identical, which silently weakens scrypt (EncryptionManager:14).
    run();
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    const values = GENERATED.map((key) => written[key]);
    expect(new Set(values).size).toBe(GENERATED.length);
  });
});

describe("ensure-secrets: what it leaves alone", () => {
  it("does not replace a value the operator already set", () => {
    const existing = GENERATED.map((key) => `${key}=operator-chose-this-${key}`).join("\n");
    fs.writeFileSync(envPath, `${existing}\n`, { mode: 0o600 });
    const before = fs.readFileSync(envPath, "utf8");

    expect(run().status).toBe(0);

    // Byte-identical, not merely "values unchanged": a rewrite that happens to
    // preserve the values still rewrites the file, and a regenerated
    // API_KEY_PEPPER invalidates every existing API key.
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  });

  it("fills only the missing keys when the file is half-populated", () => {
    fs.writeFileSync(envPath, "SIG_KEY=kept-by-operator\n", { mode: 0o600 });
    expect(run().status).toBe(0);

    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(written.SIG_KEY).toBe("kept-by-operator");
    expect(written.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(written.SIG_SALT).toMatch(/^[0-9a-f]{64}$/);
    expect(written.API_KEY_PEPPER).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps unrelated keys and their comments", () => {
    fs.writeFileSync(
      envPath,
      "# operator's own note\nLLM_PROVIDER=ollama\nSTORAGE_DIR=/data\n",
      { mode: 0o600 }
    );
    expect(run().status).toBe(0);

    const body = fs.readFileSync(envPath, "utf8");
    expect(body).toContain("# operator's own note");
    expect(body).toContain("LLM_PROVIDER=ollama");
    expect(body).toContain("STORAGE_DIR=/data");
  });

  it("is idempotent: the second run changes nothing", () => {
    expect(run().status).toBe(0);
    const first = fs.readFileSync(envPath, "utf8");
    expect(run().status).toBe(0);
    expect(fs.readFileSync(envPath, "utf8")).toBe(first);
  });
});

describe("ensure-secrets: refusing to write is a failed boot", () => {
  it("exits non-zero when writeEnvFileAtomic refuses a symlinked path", () => {
    // Ruling (4a). writeEnvFileAtomic RETURNS FALSE here (updateENV.js:2073) —
    // it does not throw — so a script that ignores the return value prints
    // "secrets generated" and boots with a pepper that exists only in this
    // process's memory. Every API key minted that run stops verifying at the
    // next restart.
    const decoy = path.join(tempDir, "decoy");
    fs.writeFileSync(decoy, "", { mode: 0o600 });
    fs.symlinkSync(decoy, envPath);

    const result = run();
    expect(result.status).not.toBe(0);
    expect(fs.readFileSync(decoy, "utf8")).toBe("");
  });

  it("says which file it could not write, and why", () => {
    const decoy = path.join(tempDir, "decoy");
    fs.writeFileSync(decoy, "", { mode: 0o600 });
    fs.symlinkSync(decoy, envPath);

    const output = [run().stdout, run().stderr].join("\n") + run().stderr;
    expect(output).toContain(envPath);
  });

  it("does not report success on the run that failed to write", () => {
    const decoy = path.join(tempDir, "decoy");
    fs.writeFileSync(decoy, "", { mode: 0o600 });
    fs.symlinkSync(decoy, envPath);

    const result = run();
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/generated|สร้าง(แล้ว)?/i);
  });
});

describe("ensure-secrets: the backup notice", () => {
  it("names all four keys on the run that generated them (ruling Q3)", () => {
    const result = run();
    for (const key of GENERATED) expect(result.stdout).toContain(key);
  });

  it("stays quiet on a run that generated nothing", () => {
    // A notice printed on every boot is a notice nobody reads.
    run();
    const second = run();
    for (const key of GENERATED) expect(second.stdout).not.toContain(key);
  });
});

describe("ensure-secrets: it must not drag in the server", () => {
  it("loads with API_KEY_PEPPER unset", () => {
    // The trap this script exists to avoid: apiKeySecurity throws at import
    // when the pepper is missing, so a generator that reaches it cannot run on
    // the one install that needs it.
    const probe = `require(${JSON.stringify(SCRIPT)});`;
    const env = { ...process.env, ENV_FILE_PATH: envPath, ENSURE_SECRETS_NOOP: "1" };
    delete env.API_KEY_PEPPER;
    expect(() =>
      execFileSync(process.execPath, ["-e", probe], { env, stdio: "pipe" })
    ).not.toThrow();
  });

  it("does not reach apiKeySecurity, prisma, or the boot tree", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/require\([^)]*apiKeySecurity/);
    expect(source).not.toMatch(/require\([^)]*prisma/);
    expect(source).not.toMatch(/require\([^)]*utils\/boot/);
  });
});

describe("ensure-secrets and the 'just me, no password' path (QA-3 ruling 1)", () => {
  // POST /system/update-password with usePassword:false sets
  // process.env.AUTH_TOKEN and process.env.JWT_SECRET to "" IN MEMORY ONLY
  // (endpoints/system.js:705-707) — it never calls updateENV, so nothing is
  // written to disk. That asymmetry is what makes this worth a test: the
  // installer's job is to leave the restart landing where the operator left it.
  it("leaves the operator without a password after a restart", () => {
    // Boot 1: fresh install, secrets generated.
    expect(run().status).toBe(0);
    const afterFirstBoot = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(afterFirstBoot).not.toHaveProperty("AUTH_TOKEN");

    // The operator picks "just me, no password". Nothing reaches the file.
    // Boot 2 must therefore still find no AUTH_TOKEN — which is exactly the
    // state validatedRequest's passthrough branch requires
    // (validatedRequest.js:29-36). Had ensure-secrets generated AUTH_TOKEN,
    // this restart would demand a password nobody can supply.
    expect(run().status).toBe(0);
    const afterSecondBoot = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(afterSecondBoot).not.toHaveProperty("AUTH_TOKEN");
  });

  it("does not rotate JWT_SECRET across restarts", () => {
    // The no-password path also blanks JWT_SECRET in memory. On the next boot
    // the value must come back from the file unchanged: regenerating it would
    // invalidate every session token the instance ever issued, so an operator
    // who restarts twice would be logged out with no explanation.
    expect(run().status).toBe(0);
    const first = parseEnv(fs.readFileSync(envPath, "utf8")).JWT_SECRET;
    expect(run().status).toBe(0);
    expect(parseEnv(fs.readFileSync(envPath, "utf8")).JWT_SECRET).toBe(first);
  });

  it("does not itself write AUTH_TOKEN back once the operator has none", () => {
    // Guards the shape where a later change makes the file the source of truth
    // for "has a password" and helpfully re-adds an empty AUTH_TOKEN. An empty
    // assignment is not the same as an absent key to assignedKeys(), so that
    // would freeze the operator out of ever setting one.
    run();
    fs.appendFileSync(envPath, "LLM_PROVIDER=ollama\n");
    run();
    expect(fs.readFileSync(envPath, "utf8")).not.toMatch(/AUTH_TOKEN/);
  });
});

describe("ensure-secrets never prints a secret (TL-2 M11)", () => {
  // The script announces what it generated so the operator knows to back the
  // keys up. That announcement is the exact place a value leaks: container
  // logs are shipped, aggregated, and retained by people who are not the
  // operator, so a printed pepper is a printed pepper forever.
  const secretsFrom = () => {
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    return GENERATED.map((key) => written[key]).filter(Boolean);
  };

  it("names the keys without printing their values", () => {
    const result = run();
    const output = `${result.stdout}${result.stderr}`;
    const values = secretsFrom();
    expect(values).toHaveLength(GENERATED.length);
    for (const value of values) expect(output).not.toContain(value);
  });

  it("prints no 64-hex-character run at all", () => {
    // Independent of the values above: catches a leak of some OTHER generated
    // value, or of a key generated by a future change that this test does not
    // know the name of.
    const result = run();
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/[0-9a-f]{64}/);
  });

  it("does not echo an operator's existing value back either", () => {
    // The half that is easy to miss: a "left alone" message that quotes what
    // it left alone leaks a value the operator chose, on every boot.
    fs.writeFileSync(envPath, "SIG_KEY=operator-secret-value-do-not-print\n", {
      mode: 0o600,
    });
    const result = run();
    expect(`${result.stdout}${result.stderr}`).not.toContain(
      "operator-secret-value-do-not-print"
    );
  });
});

describe("ensure-secrets appends, it does not rewrite (TL-2 OBS-1)", () => {
  // writeEnvFileAtomic takes the WHOLE file body, so a generator that parses
  // the file into pairs and re-serialises it would silently rewrite an
  // operator's .env: comments gone, ordering changed, and any value whose
  // quoting the parser does not reproduce exactly, corrupted.
  const AWKWARD = [
    "# a comment the operator wrote",
    "",
    'OPEN_AI_KEY="sk-with-a-#-inside"',
    "  # indented comment",
    "LLM_PROVIDER=ollama    ",
    "",
    "JWT_SECRET=already-set",
    "SIG_KEY=already-set",
    "SIG_SALT=already-set",
    "",
  ].join("\n");

  it("leaves every existing line byte-identical when adding one key", () => {
    fs.writeFileSync(envPath, `${AWKWARD}\n`, { mode: 0o600 });
    const before = fs.readFileSync(envPath, "utf8").split("\n");

    expect(run().status).toBe(0);

    const after = fs.readFileSync(envPath, "utf8").split("\n");
    // Only API_KEY_PEPPER was missing, so the original lines must appear first
    // and unchanged — compared line by line, not as a substring, because a
    // substring match tolerates reordering.
    expect(after.slice(0, before.length - 1)).toEqual(before.slice(0, -1));
  });

  it("adds the missing key as a new line at the end", () => {
    fs.writeFileSync(envPath, `${AWKWARD}\n`, { mode: 0o600 });
    run();
    const lines = fs.readFileSync(envPath, "utf8").trimEnd().split("\n");
    expect(lines[lines.length - 1]).toMatch(/^API_KEY_PEPPER=[0-9a-f]{64}$/);
  });

  it("does not disturb a value with a hash character inside it", () => {
    fs.writeFileSync(envPath, `${AWKWARD}\n`, { mode: 0o600 });
    run();
    expect(fs.readFileSync(envPath, "utf8")).toContain(
      'OPEN_AI_KEY="sk-with-a-#-inside"'
    );
  });

  it("keeps blank lines and indentation", () => {
    fs.writeFileSync(envPath, `${AWKWARD}\n`, { mode: 0o600 });
    run();
    const body = fs.readFileSync(envPath, "utf8");
    expect(body).toContain("  # indented comment");
    expect(body).toContain("LLM_PROVIDER=ollama    ");
  });

  it("adds exactly one newline when the file does not end with one", () => {
    // A file whose last line has no trailing newline would otherwise get the
    // new assignment glued onto it: `SIG_SALT=xAPI_KEY_PEPPER=y`.
    fs.writeFileSync(envPath, "JWT_SECRET=a\nSIG_KEY=b\nSIG_SALT=c", {
      mode: 0o600,
    });
    run();
    const written = parseEnv(fs.readFileSync(envPath, "utf8"));
    expect(written.SIG_SALT).toBe("c");
    expect(written.API_KEY_PEPPER).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("an unwritable directory is a remedy, not a stack trace (TL-2 OBS-2)", () => {
  // writeEnvFileAtomic THROWS here rather than returning false: the refusal
  // guards run against the file, and a directory that rejects the temp-file
  // open or the rename surfaces as an exception from fs (updateENV.js:2107).
  // So the false-return branch alone does not cover this case.
  it("exits non-zero", () => {
    fs.chmodSync(tempDir, 0o500);
    try {
      expect(run().status).not.toBe(0);
    } finally {
      fs.chmodSync(tempDir, 0o700);
    }
  });

  it("explains the problem instead of printing a stack trace", () => {
    fs.chmodSync(tempDir, 0o500);
    try {
      const result = run();
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain(envPath);
      expect(output).toMatch(/chown|UID=\$\(id -u\)/);
      // A stack trace tells the operator where our code is, not what they
      // should do. `at Object.<anonymous>` is the shape that says we let the
      // exception escape.
      expect(output).not.toMatch(/^\s+at /m);
    } finally {
      fs.chmodSync(tempDir, 0o700);
    }
  });

  it("does not claim to have generated anything", () => {
    fs.chmodSync(tempDir, 0o500);
    try {
      const result = run();
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/BACK THESE UP/);
    } finally {
      fs.chmodSync(tempDir, 0o700);
    }
  });
});
