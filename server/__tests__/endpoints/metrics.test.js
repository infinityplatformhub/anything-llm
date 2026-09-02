/* eslint-env jest */

/**
 * O5a (#90) — GET /api/metrics.
 *
 * The metric values are the easy half. The half that can hurt someone is the
 * LABELS: Prometheus labels are unbounded cardinality and plain text in every
 * scrape, so `chats_total{workspace="acme-legal-due-diligence"}` publishes a
 * customer's deal name to whoever can read the endpoint. Counters are labelled
 * by type — provider, outcome, route class — never by instance.
 *
 * The endpoint is unauthenticated by design, inside /api so it inherits
 * ipAllowlist. That is safe only as far as IP_ALLOWLIST is configured, and an
 * EMPTY allowlist means allow-everything (requestControls.js:223) — so the
 * doctor warns about that combination, and one test here holds the warning.
 */
const express = require("express");
const request = require("supertest");

// endpoints/system.js pulls the app's model tree, and apiKeySecurity throws at
// IMPORT when the pepper is short (utils/apiKeySecurity/index.js:15). Set it
// here rather than relying on the runner's environment, so the suite says the
// same thing on every machine.
process.env.API_KEY_PEPPER =
  process.env.API_KEY_PEPPER ?? "metrics-test-pepper-of-at-least-32-bytes";

function loadMetrics() {
  jest.resetModules();
  return require("../../utils/metrics");
}

function appWithMetrics() {
  const metrics = loadMetrics();
  const app = express();
  const { systemEndpoints } = require("../../endpoints/system");
  const router = express.Router();
  systemEndpoints(router);
  app.use("/api", router);
  return { app, metrics };
}

describe("the endpoint", () => {
  it("answers 200 in the Prometheus exposition format", async () => {
    const { app } = appWithMetrics();
    const response = await request(app).get("/api/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/plain/);
    expect(response.headers["content-type"]).toMatch(/version=0\.0\.4/);
  });

  it("includes the default process metrics", async () => {
    // Memory, CPU, event-loop lag, handles. This is most of the operational
    // value and none of the risk — it says nothing about the tenant.
    const { app } = appWithMetrics();
    const body = (await request(app).get("/api/metrics")).text;
    expect(body).toMatch(/process_cpu_user_seconds_total/);
    expect(body).toMatch(/nodejs_eventloop_lag_seconds/);
  });

  it("is registered next to /ping, so it inherits ipAllowlist", async () => {
    // Mounted inside /api rather than on its own port: a separate port doubles
    // what the operator has to firewall and does not compose with the
    // allowlist they already configured.
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../endpoints/system.js"),
      "utf8"
    );
    expect(source).toMatch(/app\.get\("\/metrics"/);
  });
});

describe("no label may carry user-supplied text", () => {
  it("declares its label names as a frozen constant", () => {
    // Structural, not incidental: a label set assembled at call time is one
    // refactor away from someone passing a workspace name into it.
    const metrics = loadMetrics();
    expect(Array.isArray(metrics.ALLOWED_LABEL_NAMES)).toBe(true);
    expect(Object.isFrozen(metrics.ALLOWED_LABEL_NAMES)).toBe(true);
    expect(metrics.ALLOWED_LABEL_NAMES.length).toBeGreaterThan(0);
  });

  it("names no label after a thing users can rename", () => {
    const metrics = loadMetrics();
    for (const name of metrics.ALLOWED_LABEL_NAMES) {
      expect(name).not.toMatch(
        /workspace|user|username|document|filename|thread|slug|email|prompt|endpoint|url|model_name/i
      );
    }
  });

  it("every APP metric declares only allowed label names", async () => {
    // The registry is the authority, not the source file: a counter registered
    // from anywhere in the tree still has to pass.
    //
    // Scoped to our own metrics. prom-client's defaults carry labels of their
    // own (`nodejs_active_resources{type}`, `nodejs_heap_space_size_*{space}`,
    // `nodejs_version_info{version,major,...}`) whose values are fixed by the
    // runtime, not by anything a user can type — holding them to our
    // vocabulary would be asserting on the library, and the guard that matters
    // is on the call sites we control.
    const metrics = loadMetrics();
    await request(appWithMetrics().app).get("/api/metrics");
    const ours = (await metrics.registry.getMetricsAsJSON()).filter(
      (metric) => Object.hasOwn(metrics.APP_METRIC_NAMES, metric.name)
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const metric of ours) {
      for (const value of metric.values ?? []) {
        for (const label of Object.keys(value.labels ?? {})) {
          expect(metrics.ALLOWED_LABEL_NAMES).toContain(label);
        }
      }
    }
  });

  it("declares each app metric's labels from the allowed set", () => {
    // Checked at declaration too, because a counter with no samples yet has no
    // labels to inspect above — a new metric could sit in the registry
    // unexercised, with a leaking label, until the first request hits it.
    const metrics = loadMetrics();
    for (const labelNames of Object.values(metrics.APP_METRIC_NAMES)) {
      for (const label of labelNames) {
        expect(metrics.ALLOWED_LABEL_NAMES).toContain(label);
      }
    }
  });

  it("refuses a label value at runtime rather than publishing it", () => {
    // The guard has to hold when a future call site gets it wrong, not only
    // when the label NAME is wrong — `provider: workspace.name` type-checks
    // fine and leaks on the next scrape.
    const metrics = loadMetrics();
    expect(() =>
      metrics.observe("chats_total", { workspace: "acme-legal-due-diligence" })
    ).toThrow(/label/i);
  });

  it("does not leak a value through an allowed label either", async () => {
    // An allowed NAME with a free-text VALUE is the same leak wearing a
    // different hat. Values are constrained to a declared set.
    const metrics = loadMetrics();
    expect(() =>
      metrics.observe("chats_total", { provider: "acme-legal-due-diligence" })
    ).toThrow(/value/i);
  });
});

describe("what the counters count", () => {
  it("counts by type, and the type set is closed", () => {
    const metrics = loadMetrics();
    expect(Object.isFrozen(metrics.ALLOWED_LABEL_VALUES)).toBe(true);
    for (const values of Object.values(metrics.ALLOWED_LABEL_VALUES)) {
      expect(Object.isFrozen(values)).toBe(true);
      expect(values.length).toBeGreaterThan(0);
    }
  });

  it("accepts a declared value", () => {
    const metrics = loadMetrics();
    const provider = metrics.ALLOWED_LABEL_VALUES.provider[0];
    expect(() => metrics.observe("chats_total", { provider })).not.toThrow();
  });

  it("increments the counter it was told to", async () => {
    const metrics = loadMetrics();
    const provider = metrics.ALLOWED_LABEL_VALUES.provider[0];
    metrics.observe("chats_total", { provider });
    metrics.observe("chats_total", { provider });
    const body = await metrics.registry.metrics();
    expect(body).toMatch(
      new RegExp(`chats_total\\{provider="${provider}"\\} 2`)
    );
  });

  it("rejects a metric nobody registered", () => {
    // Silently creating one on first use would let a typo become a metric that
    // nothing ever reports, which reads as "zero" on a dashboard.
    const metrics = loadMetrics();
    expect(() => metrics.observe("chats_totl", {})).toThrow(/unknown metric/i);
  });
});

describe("the allowlist caveat is stated where it matters", () => {
  // The exposure check reads configuration only, so these run against an
  // unreachable database on purpose: the database checks fail, which is
  // irrelevant here and keeps the suite runnable anywhere.
  const dbless = () => ({
    databaseUrl: "postgresql://nobody:nobody@127.0.0.1:1/none",
    envPath: require("path").join(__dirname, "../../.env"),
    storageDir: process.env.STORAGE_DIR,
  });

  it("the endpoint says an empty IP_ALLOWLIST makes this public", () => {
    // requestControls.js:223 returns next() when the allowlist is empty, which
    // is the DEFAULT install. Anyone reading this route later must meet that
    // fact here rather than deduce it from the middleware.
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../endpoints/system.js"),
      "utf8"
    );
    const at = source.indexOf('app.get("/metrics"');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, at - 1200), at)).toMatch(/IP_ALLOWLIST/);
  });

  it("registers the exposure check as a warning with a remedy", async () => {
    // #74's preflight is where an operator finds out about their own
    // configuration, so this belongs there rather than in a log line at boot.
    // Warn, not block: an instance on a private network is fine as it is.
    const doctor = require("../../utils/doctor");
    expect(doctor.CHECK_IDS).toContain("config.metrics_exposure");
    expect(doctor.levelOf("config.metrics_exposure")).toBe("warn");
    expect(doctor.remedyOf("config.metrics_exposure")).toMatch(/IP_ALLOWLIST/);
  });

  it("actually fails that check when IP_ALLOWLIST is empty", async () => {
    // The three assertions above are satisfied by a check that always passes —
    // found by mutation: hardcoding `configured = true` left them all green.
    // This is the one that holds the verdict.
    const doctor = require("../../utils/doctor");
    const results = await doctor.runChecks({
      ...dbless(),
      ipAllowlist: "",
    });
    const check = results.find((r) => r.id === "config.metrics_exposure");
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/every address|unauthenticated/i);
  });

  it("passes it once an allowlist is configured", async () => {
    const doctor = require("../../utils/doctor");
    const results = await doctor.runChecks({
      ...dbless(),
      ipAllowlist: "10.0.0.0/8",
    });
    expect(
      results.find((r) => r.id === "config.metrics_exposure").ok
    ).toBe(true);
  });

  it("treats a whitespace-only allowlist as empty", async () => {
    // `IP_ALLOWLIST=" "` is invisible in a .env file and parses to nothing.
    const doctor = require("../../utils/doctor");
    const results = await doctor.runChecks({ ...dbless(), ipAllowlist: "   " });
    expect(
      results.find((r) => r.id === "config.metrics_exposure").ok
    ).toBe(false);
  });
});
