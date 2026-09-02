/* eslint-env jest */

/**
 * O5a-wire (#102) — the 41 → 7 mapping.
 *
 * The resolver in utils/helpers accepts 41 provider strings and the metrics
 * vocabulary allows 7, so a call site cannot pass `process.env.LLM_PROVIDER`
 * through: on most real installs that throws. This suite holds the mapping
 * total, and holds it against the RESOLVER'S OWN list scanned from source
 * rather than a list written here, so a provider added later fails this test on
 * the day it is added instead of leaking an unmapped value into a label.
 */
const fs = require("fs");
const path = require("path");
const {
  providerLabel,
  PROVIDER_LABELS,
  ALLOWED_LABEL_VALUES,
  observe,
} = require("../../../utils/metrics");

const HELPERS = path.join(__dirname, "../../../utils/helpers/index.js");

/** Every `case "x":` inside one named function in the helpers source. */
function providerCasesIn(functionName) {
  const source = fs.readFileSync(HELPERS, "utf8");
  const start = source.indexOf(`function ${functionName}(`);
  expect(start).toBeGreaterThan(-1);
  // to the next top-level function declaration
  const rest = source.slice(start + 1);
  const end = rest.indexOf("\nfunction ");
  const body = end === -1 ? rest : rest.slice(0, end);
  return [...new Set([...body.matchAll(/case "([a-z0-9-]+)":/g)].map((m) => m[1]))];
}

describe("providerLabel — the mapping is total", () => {
  const llmProviders = providerCasesIn("resolveLLMProviderInstance");
  const embedEngines = providerCasesIn("resolveEmbeddingEngineInstance");

  it("finds the provider list in the resolver, so this suite cannot silently test nothing", () => {
    // A scan that matched nothing would make every it.each below vacuous.
    expect(llmProviders.length).toBeGreaterThan(30);
    expect(embedEngines.length).toBeGreaterThan(5);
    expect(llmProviders).toContain("openai");
    expect(llmProviders).toContain("anythingllm-router");
  });

  it.each(llmProviders)("maps LLM provider %s to a declared label value", (provider) => {
    const label = providerLabel(provider);
    expect(`${provider} -> ${label}`).toBe(
      `${provider} -> ${ALLOWED_LABEL_VALUES.provider.includes(label) ? label : "REJECTED"}`
    );
    // and the label is actually accepted by the guard, not merely in the array
    expect(() => observe("chats_total", { provider: label })).not.toThrow();
  });

  it.each(embedEngines)("maps embedding engine %s to a declared label value", (engine) => {
    expect(ALLOWED_LABEL_VALUES.provider).toContain(providerLabel(engine));
  });

  it("maps an unknown provider to other, and does NOT pass it through", () => {
    // Passthrough is the failure in miniature: an unlisted value reaching a
    // label is the thing the vocabulary exists to prevent, and it would fire on
    // exactly the values nobody anticipated.
    expect(providerLabel("ppio")).toBe("other");
    expect(providerLabel("some-provider-invented-tomorrow")).toBe("other");
    expect(providerLabel("anythingllm-router")).toBe("other");
  });

  it("maps absent and empty values to other rather than throwing", () => {
    // It runs on the way INTO observe; a mapping that threw would produce the
    // failure it exists to avoid.
    for (const value of [undefined, null, "", "   "])
      expect(providerLabel(value)).toBe("other");
  });

  it("is case- and whitespace-insensitive, because env values are typed by hand", () => {
    expect(providerLabel("OpenAI")).toBe("openai");
    expect(providerLabel("  ollama  ")).toBe("ollama");
  });

  it("keeps the table frozen and every entry inside the vocabulary", () => {
    expect(Object.isFrozen(PROVIDER_LABELS)).toBe(true);
    for (const label of Object.values(PROVIDER_LABELS))
      expect(ALLOWED_LABEL_VALUES.provider).toContain(label);
  });
});

describe("the label guard still bites", () => {
  // The assertion that this issue did not quietly widen the vocabulary to make
  // wiring easier.
  it("refuses a workspace slug as a label value", () => {
    expect(() =>
      observe("chats_total", { provider: "acme-legal-due-diligence" })
    ).toThrow(/never come from user-supplied text/);
  });

  it("refuses a label name that is not declared", () => {
    expect(() => observe("chats_total", { workspace: "anything" })).toThrow(
      /not allowed/
    );
  });

  it("no longer declares the kind label or operations_total", () => {
    // Ruling 2: operations_total duplicated what the four specific counters
    // report, and a label with no metric using it invites a use to be found.
    const metrics = require("../../../utils/metrics");
    expect(metrics.ALLOWED_LABEL_NAMES).not.toContain("kind");
    expect(Object.keys(metrics.APP_METRIC_NAMES)).not.toContain(
      "operations_total"
    );
  });
});
