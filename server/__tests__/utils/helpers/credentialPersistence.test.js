/**
 * P0-4D(c) part 3: where a provider credential persists.
 *
 * Part 2 built the encrypted store; nothing used it. This is the half that stops the
 * .env file from being the place secrets live: a credential-declared setting goes to
 * the store, dumpENV no longer writes it to disk, and boot loads it back.
 */
const {
  KEY_MAPPING,
  loadStoredCredentials,
} = require("../../../utils/helpers/updateENV");

describe("dumpENV no longer writes credential values to the file", () => {
  // Drives the real dumpENV against a temp path. An earlier version of this test
  // re-derived dumpENV's own allowlist and asserted against that, which would have
  // passed even if dumpENV never changed — it tested the test.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { dumpENV } = require("../../../utils/helpers/updateENV");

  const SECRET_CANARY = "sk-should-never-reach-disk-4f2a";
  const PLAIN_VALUE = "openai";
  const URL_VALUE = "http://127.0.0.1:11434";
  const KEYS = ["OPEN_AI_KEY", "LLM_PROVIDER", "OLLAMA_BASE_PATH"];

  let written;
  let dir;
  const originals = {};

  beforeAll(() => {
    for (const key of KEYS) originals[key] = process.env[key];
    process.env.OPEN_AI_KEY = SECRET_CANARY;
    process.env.LLM_PROVIDER = PLAIN_VALUE;
    process.env.OLLAMA_BASE_PATH = URL_VALUE;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "dumpenv-"));
    const target = path.join(dir, ".env");
    dumpENV({ envPath: target });
    written = fs.readFileSync(target, "utf8");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("a credential value does not reach the file", () => {
    expect(written).not.toContain(SECRET_CANARY);
    expect(written).not.toContain("OPEN_AI_KEY=");
  });

  test("no credential-declared setting appears at all", () => {
    const secretEnvKeys = Object.values(KEY_MAPPING)
      .filter((entry) => entry.secret === true)
      .map((entry) => entry.envKey);
    expect(secretEnvKeys.length).toBeGreaterThan(50);
    for (const envKey of secretEnvKeys) expect(written).not.toContain(`${envKey}=`);
  });

  test("ordinary settings are still written", () => {
    expect(written).toContain(`LLM_PROVIDER='${PLAIN_VALUE}'`);
  });

  test("endpoints are still written, because a host is configuration", () => {
    // secret: "url" values keep their host; only inline userinfo is a credential.
    expect(written).toContain("OLLAMA_BASE_PATH=");
  });
});

describe("boot loads stored credentials back into the environment", () => {
  const originals = {};
  const remember = (key) => {
    originals[key] = process.env[key];
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const storeWith = (rows, { failing = [] } = {}) => ({
    keys: async () => Object.keys(rows),
    get: async (envKey) => (failing.includes(envKey) ? null : rows[envKey]),
  });

  test("a stored credential reaches process.env", async () => {
    remember("OPEN_AI_KEY");
    delete process.env.OPEN_AI_KEY;

    const result = await loadStoredCredentials(
      storeWith({ OPEN_AI_KEY: "sk-from-the-store" })
    );

    expect(process.env.OPEN_AI_KEY).toBe("sk-from-the-store");
    expect(result.loaded).toEqual(["OPEN_AI_KEY"]);
  });

  test("a value already in the environment wins over the stored row", async () => {
    // An operator setting a variable directly, or a container injecting one, is making
    // a deliberate override; a database row must not silently replace it.
    remember("OPEN_AI_KEY");
    process.env.OPEN_AI_KEY = "sk-set-by-the-operator";

    const result = await loadStoredCredentials(
      storeWith({ OPEN_AI_KEY: "sk-from-the-store" })
    );

    expect(process.env.OPEN_AI_KEY).toBe("sk-set-by-the-operator");
    expect(result.skipped).toEqual(["OPEN_AI_KEY"]);
    expect(result.loaded).toEqual([]);
  });

  test("a row that fails its auth tag leaves the variable unset", async () => {
    // get() returns null for a tampered row. Unset is right: a provider that is not
    // configured fails loudly at first use, where a tampered value fails silently or
    // somewhere worse.
    remember("ANTHROPIC_API_KEY");
    delete process.env.ANTHROPIC_API_KEY;

    const result = await loadStoredCredentials(
      storeWith({ ANTHROPIC_API_KEY: "unreachable" }, { failing: ["ANTHROPIC_API_KEY"] })
    );

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.loaded).toEqual([]);
  });

  test("an unreachable store does not stop the server booting", async () => {
    const errors = jest.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      keys: async () => {
        throw new Error("connection refused");
      },
      get: async () => null,
    };

    await expect(loadStoredCredentials(broken)).resolves.toEqual({
      loaded: [],
      skipped: [],
    });
    errors.mockRestore();
  });
});

describe("both boot paths load credentials", () => {
  // The legacy-wildcard report shipped in bootHTTP only, and an HTTPS deployment saw
  // nothing (QA-1, #27). A credential loader with the same gap would leave every
  // provider unconfigured on HTTPS instead.
  const source = require("fs").readFileSync(
    require("path").resolve(__dirname, "../../../utils/boot/index.js"),
    "utf8"
  );

  test("bootHTTP and bootSSL both call loadStoredCredentials", () => {
    expect(source.match(/await loadStoredCredentials\(\)/g)).toHaveLength(2);
  });

  test("it runs before anything that could construct a provider client", () => {
    const httpBody = source.slice(source.indexOf("function bootHTTP"));
    expect(httpBody.indexOf("loadStoredCredentials")).toBeLessThan(
      httpBody.indexOf("markOnboarded")
    );
  });
});
