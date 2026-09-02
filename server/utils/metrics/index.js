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
const ALLOWED_LABEL_NAMES = Object.freeze(["provider", "outcome"]);

/**
 * And the values each may take. An allowed NAME with a free-text VALUE is the
 * same leak wearing a different hat, so the values are closed too.
 *
 * `provider` is a class of integration, never an endpoint or a model name: an
 * operator's self-hosted URL is as identifying as a workspace title.
 *
 * O5a-wire (#102) removed the `kind` label along with the `operations_total`
 * counter that was its only user. Its values duplicated what the four specific
 * counters report, and two counters for one event means two dashboards that
 * disagree with nothing to say which is right. A label with no metric using it
 * is an invitation to find a use for it, which is how a vocabulary widens
 * without anyone deciding to widen it.
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
};

/**
 * The resolver accepts 41 provider strings; `provider` allows 7. So a call site
 * cannot pass `process.env.LLM_PROVIDER` through — on most real installs that
 * throws.
 *
 * One table, and anything not in it becomes `"other"`. NEVER a passthrough: an
 * unlisted value reaching a label is the exact thing the vocabulary exists to
 * prevent, and passthrough would make the guard fire on the values nobody
 * anticipated, which are the ones worth guarding against.
 *
 * Widening the vocabulary to 41 values instead would defeat its purpose.
 * Cardinality is why the list is short, and a dashboard does not need to
 * distinguish `ppio` from `novita` — an operator debugging one knows which they
 * configured. The `provider` label answers "which class of integration", and
 * the specific product is in the environment, where it is already reported.
 *
 * Never throws: it is called on the way INTO `observe`, and a mapping that
 * threw would turn an unmapped provider into the failure the mapping exists to
 * avoid.
 */
const PROVIDER_LABELS = Object.freeze({
  openai: "openai",
  azure: "azure",
  anthropic: "anthropic",
  ollama: "ollama",
  localai: "localai",
  native: "native",
});

function providerLabel(raw) {
  const key = String(raw ?? "").trim().toLowerCase();
  return PROVIDER_LABELS[key] ?? "other";
}

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

/**
 * Every call site increments through THIS, not through `observe` directly.
 *
 * Two failures to avoid at once. `observe` throws by design, and a throw inside
 * a chat handler would turn a metrics bug into a user-visible 500 — the
 * observability breaking the thing it observes. But swallowing it silently
 * returns to a counter that reports zero forever with nobody noticing, which is
 * the condition wiring these counters exists to end.
 *
 * So: log and continue. In tests `observe` still throws and is still a hard
 * failure; in production the mistake lands in the log.
 *
 * WHAT THE LOG SAYS: the metric and the label NAME. Never the rejected VALUE. A
 * rejected value is by definition one that was not supposed to be published,
 * and writing it into a log to explain why it was not published is the same
 * leak one file over.
 *
 * ONCE per (metric, label) per process. An install whose provider does not map
 * would otherwise log on every chat.
 */
const warnedObservations = new Set();

function safeObserve(name, labels = {}) {
  try {
    observe(name, labels);
  } catch (error) {
    // The label NAME, taken from our own keys — not from the error text, which
    // quotes the value that was rejected.
    const labelNames = Object.keys(labels).sort().join(",");
    const key = `${name}:${labelNames}`;
    if (warnedObservations.has(key)) return;
    warnedObservations.add(key);
    console.warn(
      `[metrics] refused to record "${name}" with label(s) [${labelNames}]; the value is not in the declared vocabulary and is not logged here`
    );
  }
}

/** Test seam: the once-per-process memory would otherwise leak across tests. */
function __resetObservationWarnings() {
  warnedObservations.clear();
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
  providerLabel,
  PROVIDER_LABELS,
  safeObserve,
  __resetObservationWarnings,
  APP_METRIC_NAMES,
  observe,
  render,
  ALLOWED_LABEL_NAMES,
  ALLOWED_LABEL_VALUES,
};
