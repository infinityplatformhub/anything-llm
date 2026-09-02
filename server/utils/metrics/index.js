/**
 * O5a (#90) — Prometheus metrics.
 *
 * The exposition format and the process gauges come from prom-client. What this
 * module adds is a closed vocabulary, because the risk in a metrics endpoint is
 * not the numbers, it is the LABELS.
 *
 * Prometheus labels are unbounded cardinality and plain text in every scrape.
 * A counter labelled `{workspace: "acme-legal-due-diligence"}` publishes a
 * customer's deal name to everyone who can read the endpoint — and the endpoint
 * is unauthenticated, sitting behind an IP allowlist that is EMPTY on a default
 * install (utils/middleware/requestControls.js:223).
 *
 * So both halves are declared and enforced at the call site: the label names,
 * and the values each may take. A call site that gets it wrong throws, rather
 * than publishing on the next scrape.
 */
const client = require("prom-client");

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

/**
 * Every label name any metric here may use. Frozen, and checked in a test
 * against words for things users can rename — a label assembled at call time is
 * one refactor away from carrying a workspace name.
 */
const ALLOWED_LABEL_NAMES = Object.freeze([
  "provider",
  "outcome",
  "kind",
]);

/**
 * And the values each may take. An allowed NAME with a free-text VALUE is the
 * same leak wearing a different hat, so the values are closed too.
 *
 * `provider` is a class of integration, never an endpoint or a model name: an
 * operator's self-hosted URL is as identifying as a workspace title.
 */
const ALLOWED_LABEL_VALUES = Object.freeze({
  provider: Object.freeze([
    "openai",
    "azure",
    "anthropic",
    "ollama",
    "localai",
    "native",
    "other",
  ]),
  outcome: Object.freeze(["success", "failure"]),
  kind: Object.freeze(["chat", "embedding", "document", "login"]),
});

const COUNTERS = {
  chats_total: new client.Counter({
    name: "chats_total",
    help: "Chat completions served, by provider class.",
    labelNames: ["provider"],
    registers: [registry],
  }),
  embeddings_total: new client.Counter({
    name: "embeddings_total",
    help: "Embedding batches computed, by provider class.",
    labelNames: ["provider"],
    registers: [registry],
  }),
  documents_total: new client.Counter({
    name: "documents_total",
    help: "Documents processed, by outcome.",
    labelNames: ["outcome"],
    registers: [registry],
  }),
  auth_attempts_total: new client.Counter({
    name: "auth_attempts_total",
    help: "Authentication attempts, by outcome.",
    labelNames: ["outcome"],
    registers: [registry],
  }),
  operations_total: new client.Counter({
    name: "operations_total",
    help: "Instance operations, by kind and outcome.",
    labelNames: ["kind", "outcome"],
    registers: [registry],
  }),
};

/**
 * Increment a counter, refusing anything not declared above.
 *
 * Throwing is deliberate. The alternative — dropping the label and counting
 * anyway — hides the mistake until someone reads a dashboard and finds the
 * dimension they were counting on is missing.
 *
 * @param {string} name a registered counter
 * @param {Record<string,string>} labels
 */
function observe(name, labels = {}) {
  const counter = COUNTERS[name];
  // Not created on first use: a typo would become a metric nothing ever
  // reports, which reads as a legitimate zero on a dashboard.
  if (!counter) throw new Error(`metrics: unknown metric "${name}"`);

  for (const [label, value] of Object.entries(labels)) {
    if (!ALLOWED_LABEL_NAMES.includes(label))
      throw new Error(
        `metrics: label "${label}" is not allowed; labels are ${ALLOWED_LABEL_NAMES.join(", ")}`
      );
    if (!ALLOWED_LABEL_VALUES[label].includes(value))
      throw new Error(
        `metrics: label value "${value}" is not allowed for "${label}"; a label value must never come from user-supplied text`
      );
  }

  counter.inc(labels);
}

/** The exposition body and its content type. */
async function render() {
  return {
    contentType: registry.contentType,
    body: await registry.metrics(),
  };
}

/**
 * Our own counters and the labels each declares — the app metrics, apart from
 * prom-client's process defaults. Exported so the tests can hold this module's
 * call sites to the vocabulary without asserting on the library's.
 */
const APP_METRIC_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(COUNTERS).map(([name, counter]) => [
      name,
      Object.freeze([...(counter.labelNames ?? [])]),
    ])
  )
);

module.exports = {
  registry,
  APP_METRIC_NAMES,
  observe,
  render,
  ALLOWED_LABEL_NAMES,
  ALLOWED_LABEL_VALUES,
};
