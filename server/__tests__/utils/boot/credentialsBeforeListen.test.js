/**
 * #115: `loadStoredCredentials()` must finish BEFORE the port accepts requests.
 *
 * It used to run inside the `listen()` callback. The callback's own steps are
 * ordered correctly relative to each other — the comment even said "first" —
 * but the callback runs after the socket is open, so every request arriving in
 * that window is served with all 97 `secret: true` keys absent from
 * process.env. Since #48 stopped writing credential values to disk, the
 * database row is the only copy, so this is not a cold-cache race: it is the
 * difference between "configured" and "not configured" for the whole window.
 *
 * These tests assert on TIME, not on where the call sits in the file. A source
 * assertion would pass the moment someone moved the line back and wrapped it in
 * something that still resolved late, and it would say nothing about whether a
 * request could actually get in first.
 */

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR ||
  require("fs").mkdtempSync(
    require("path").join(require("os").tmpdir(), "i115-boot-")
  );
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER || "i115-boot-api-key-pepper-32-bytes-minimum";

const express = require("express");

// A store whose reads are slow enough to make the window unmistakable. 200ms
// per key over 3 keys is 600ms of hydration -- far longer than the millisecond
// or two a request needs to arrive, so a late hydrate cannot pass by luck.
const KEY_DELAY_MS = 200;
const STORED = {
  PROBE_OPENAI_KEY: "sk-probe-openai",
  PROBE_SMTP_PASSWORD: "probe-smtp",
  PROBE_ANTHROPIC_KEY: "sk-probe-anthropic",
};

function makeSlowStore({ keysThrow = false } = {}) {
  const reads = [];
  return {
    store: {
      keys: async () => {
        if (keysThrow) throw new Error("credential store unreachable");
        return Object.keys(STORED);
      },
      get: async (envKey) => {
        await new Promise((resolve) => setTimeout(resolve, KEY_DELAY_MS));
        reads.push(envKey);
        return STORED[envKey] ?? null;
      },
    },
    reads,
  };
}

function clearProbeEnv() {
  for (const key of Object.keys(STORED)) delete process.env[key];
}

/**
 * Boots one app the way utils/boot does, with the hydrate placed either before
 * listen() (the fix) or inside the callback (the defect), and reports what the
 * first request saw.
 *
 * The request fires the instant listen()'s callback would first be able to run,
 * which is what a real client racing a boot does.
 */
async function bootAndProbe({ hydrateBeforeListen, store }) {
  const {
    loadStoredCredentials,
  } = require("../../../utils/helpers/updateENV");

  const app = express();
  const observed = [];
  app.get("/probe", (_request, response) => {
    // What a handler sees is the whole point: a route that reads a secret gets
    // undefined during the window.
    response.json({
      openai: process.env.PROBE_OPENAI_KEY ?? null,
      smtp: process.env.PROBE_SMTP_PASSWORD ?? null,
    });
  });

  if (hydrateBeforeListen) await loadStoredCredentials(store);

  let server;
  await new Promise((resolve) => {
    server = app.listen(0, async () => {
      if (!hydrateBeforeListen) await loadStoredCredentials(store);
      observed.push("hydrate-done");
      resolve();
    });
  });

  const port = server.address().port;
  // Fire immediately -- do not await the listen promise above before sending.
  const answer = await fetch(`http://127.0.0.1:${port}/probe`).then((r) =>
    r.json()
  );

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  return answer;
}

/**
 * The same race, but the request is sent the moment the socket is open rather
 * than after the listen() promise resolves -- this is the real window.
 */
async function raceFirstRequest({ hydrateBeforeListen, store }) {
  const {
    loadStoredCredentials,
  } = require("../../../utils/helpers/updateENV");

  const app = express();
  app.get("/probe", (_request, response) => {
    response.json({ openai: process.env.PROBE_OPENAI_KEY ?? null });
  });

  if (hydrateBeforeListen) await loadStoredCredentials(store);

  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const hydrateFinished = hydrateBeforeListen
    ? Promise.resolve()
    : loadStoredCredentials(store);

  const port = server.address().port;
  const answer = await fetch(`http://127.0.0.1:${port}/probe`).then((r) =>
    r.json()
  );
  await hydrateFinished;

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  return answer;
}

beforeEach(() => {
  clearProbeEnv();
});

afterAll(() => {
  clearProbeEnv();
});

describe("#115 R1: the first request cannot beat the credential hydrate", () => {
  test("hydrating before listen: the first request sees the secrets", async () => {
    const { store } = makeSlowStore();
    const answer = await raceFirstRequest({
      hydrateBeforeListen: true,
      store,
    });
    expect(answer.openai).toBe(STORED.PROBE_OPENAI_KEY);
  });

  test("hydrating inside the callback: the first request sees nothing", async () => {
    // This is the DEFECT reproduced, not an aspiration. It documents the window
    // the fix closes; if this ever starts passing, the harness has stopped
    // being able to observe the race and R2 below would go quiet with it.
    const { store } = makeSlowStore();
    const answer = await raceFirstRequest({
      hydrateBeforeListen: false,
      store,
    });
    expect(answer.openai).toBeNull();
  });

  test("bootHTTP itself hydrates before the port opens", async () => {
    // The two tests above drive a local reproduction of the boot shape, which
    // proves the harness can SEE the race but says nothing about utils/boot.
    // This one calls the production function, so moving the hydrate back into
    // the callback (R2) turns it red.
    const { store, reads } = makeSlowStore();
    const { bootHTTP } = require("../../../utils/boot");

    let sawDuringRequest = null;
    const app = express();
    app.get("/probe", (_request, response) => {
      sawDuringRequest = process.env.PROBE_OPENAI_KEY ?? null;
      response.json({ openai: sawDuringRequest });
    });

    const started = Date.now();
    const { server } = await bootHTTP(app, 0, { credentialStore: store });
    const elapsed = Date.now() - started;

    const port = server.address().port;
    const answer = await fetch(`http://127.0.0.1:${port}/probe`).then((r) =>
      r.json()
    );

    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));

    expect(answer.openai).toBe(STORED.PROBE_OPENAI_KEY);
    // Every key was actually read -- an empty store would satisfy the
    // assertion above while proving nothing.
    expect(reads.sort()).toEqual(Object.keys(STORED).sort());
    // bootHTTP must not have RESOLVED before the reads finished: three 200ms
    // reads cannot complete in under ~600ms. A hydrate left in the callback
    // returns from bootHTTP immediately and fails here.
    expect(elapsed).toBeGreaterThanOrEqual(KEY_DELAY_MS * 3);
  });

  test("bootSSL's own path hydrates before the port opens", async () => {
    // R5. The fallback test below only reaches bootHTTP, so it cannot see
    // bootSSL's own hydrate at all -- removing that line leaves it green.
    // Real certs are needed to exercise the success path.
    const fs = require("fs");
    const os = require("os");
    const nodePath = require("path");
    const certDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "i115-cert-"));
    const { execSync } = require("child_process");
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout ${certDir}/key.pem -out ${certDir}/cert.pem -days 2 -nodes -subj "/CN=localhost"`,
      { stdio: "pipe" }
    );

    const { store, reads } = makeSlowStore();
    const { bootSSL } = require("../../../utils/boot");
    const app = express();
    app.get("/probe", (_request, response) => {
      response.json({ openai: process.env.PROBE_OPENAI_KEY ?? null });
    });

    const prior = {
      key: process.env.HTTPS_KEY_PATH,
      cert: process.env.HTTPS_CERT_PATH,
    };
    process.env.HTTPS_KEY_PATH = `${certDir}/key.pem`;
    process.env.HTTPS_CERT_PATH = `${certDir}/cert.pem`;
    const priorReject = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const started = Date.now();
      const { server } = await bootSSL(app, 0, { credentialStore: store });
      const elapsed = Date.now() - started;
      const port = server.address().port;
      // undici ignores NODE_TLS_REJECT_UNAUTHORIZED, so a self-signed cert
      // needs https.request rather than fetch.
      const https = require("https");
      const answer = await new Promise((resolve, reject) => {
        const request = https.request(
          {
            host: "127.0.0.1",
            port,
            path: "/probe",
            method: "GET",
            rejectUnauthorized: false,
          },
          (res) => {
            let raw = "";
            res.on("data", (chunk) => (raw += chunk));
            res.on("end", () => resolve(JSON.parse(raw)));
          }
        );
        request.on("error", reject);
        request.end();
      });
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));

      expect(answer.openai).toBe(STORED.PROBE_OPENAI_KEY);
      expect(reads.sort()).toEqual(Object.keys(STORED).sort());
      // bootSSL must not resolve before the reads finish.
      expect(elapsed).toBeGreaterThanOrEqual(KEY_DELAY_MS * 3);
    } finally {
      if (prior.key === undefined) delete process.env.HTTPS_KEY_PATH;
      else process.env.HTTPS_KEY_PATH = prior.key;
      if (prior.cert === undefined) delete process.env.HTTPS_CERT_PATH;
      else process.env.HTTPS_CERT_PATH = prior.cert;
      if (priorReject === undefined)
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = priorReject;
      fs.rmSync(certDir, { recursive: true, force: true });
    }
  });

  test("bootSSL falls back to bootHTTP and still hydrates first", async () => {
    // R5: both paths. bootSSL with no cert env falls into its catch and
    // delegates to bootHTTP, which is the path a misconfigured deployment
    // actually takes.
    const { store } = makeSlowStore();
    const { bootSSL } = require("../../../utils/boot");

    const app = express();
    app.get("/probe", (_request, response) => {
      response.json({ openai: process.env.PROBE_OPENAI_KEY ?? null });
    });

    const priorEnable = process.env.ENABLE_HTTPS;
    const priorKey = process.env.HTTPS_KEY_PATH;
    delete process.env.HTTPS_KEY_PATH;
    try {
      const { server } = await bootSSL(app, 0, { credentialStore: store });
      const port = server.address().port;
      const answer = await fetch(`http://127.0.0.1:${port}/probe`).then((r) =>
        r.json()
      );
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
      expect(answer.openai).toBe(STORED.PROBE_OPENAI_KEY);
    } finally {
      if (priorEnable !== undefined) process.env.ENABLE_HTTPS = priorEnable;
      if (priorKey !== undefined) process.env.HTTPS_KEY_PATH = priorKey;
    }
  });
});

describe("#115 R3/R4/R6: the surrounding contract", () => {
  test("R3 positive control: a handler reads a hydrated credential over HTTP", async () => {
    const { store } = makeSlowStore();
    const answer = await bootAndProbe({ hydrateBeforeListen: true, store });
    // 200 with real values -- guards against a suite that would pass because
    // the server never came up at all.
    expect(answer.openai).toBe(STORED.PROBE_OPENAI_KEY);
  });

  test("R4: a store that throws does not stop the boot", async () => {
    const { store } = makeSlowStore({ keysThrow: true });
    const {
      loadStoredCredentials,
    } = require("../../../utils/helpers/updateENV");
    const result = await loadStoredCredentials(store);
    // Boot must not depend on the store being reachable: no throw, and an
    // honest empty result rather than a pretend-success.
    expect(result).toEqual({ loaded: [], skipped: [] });

    const answer = await bootAndProbe({ hydrateBeforeListen: true, store });
    expect(answer.openai).toBeNull();
  });

  test("R6: an env value already set wins over the stored row", async () => {
    process.env.PROBE_OPENAI_KEY = "set-by-operator";
    const { store, reads } = makeSlowStore();
    const {
      loadStoredCredentials,
    } = require("../../../utils/helpers/updateENV");
    const result = await loadStoredCredentials(store);

    expect(process.env.PROBE_OPENAI_KEY).toBe("set-by-operator");
    expect(result.skipped).toContain("PROBE_OPENAI_KEY");
    expect(result.loaded).not.toContain("PROBE_OPENAI_KEY");
    // Skipped means never read, not read-and-discarded: an operator's value
    // must not be fetched from the store at all.
    expect(reads).not.toContain("PROBE_OPENAI_KEY");
  });
});
