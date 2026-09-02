/* eslint-env jest */

/**
 * O5a-wire (#102) — the counters are actually incremented.
 *
 * Every assertion here reads the VALUE OUT OF THE REGISTRY rather than counting
 * calls to a spy. A spy proves this test called a function; the registry proves
 * a scrape would report the number, which is the thing the issue is for.
 */
const {
  registry,
  observe,
  safeObserve,
  providerLabel,
  ALLOWED_LABEL_NAMES,
  __resetObservationWarnings,
} = require("../../../utils/metrics");

/**
 * The counter's current value for one label set, straight from the registry.
 *
 * Returns `null` when the label set has never been observed and a NUMBER when
 * it has. The distinction matters: `0` is a real reported value, and collapsing
 * "never seen" into it would let the test below pass while `chats_total` was
 * being published under the raw provider string.
 */
async function counterValue(name, labels = {}) {
  const metrics = await registry.getMetricsAsJSON();
  const metric = metrics.find((entry) => entry.name === name);
  if (!metric) return null;
  const match = metric.values.find((value) =>
    Object.entries(labels).every(([key, want]) => value.labels[key] === want)
  );
  return match ? match.value : null;
}

/** `null` means never observed; for arithmetic that reads as zero. */
const asNumber = (value) => value ?? 0;

beforeEach(() => __resetObservationWarnings());

describe("documents_total counts per document, not per call", () => {
  it("records one outcome per document in a mixed batch", async () => {
    const before = {
      success: asNumber(await counterValue("documents_total", { outcome: "success" })),
      failure: asNumber(await counterValue("documents_total", { outcome: "failure" })),
    };

    // The shape models/documents.js produces: three documents, one of which
    // fails to vectorize. Counting once per CALL would report a single outcome
    // for a batch that had both.
    const batch = [
      { ok: true },
      { ok: false },
      { ok: true },
    ];
    for (const doc of batch)
      safeObserve("documents_total", {
        outcome: doc.ok ? "success" : "failure",
      });

    expect(await counterValue("documents_total", { outcome: "success" })).toBe(
      before.success + 2
    );
    expect(await counterValue("documents_total", { outcome: "failure" })).toBe(
      before.failure + 1
    );
  });
});

describe("auth_attempts_total records every outcome", () => {
  it("counts a refusal and a success separately", async () => {
    const before = {
      success: asNumber(await counterValue("auth_attempts_total", { outcome: "success" })),
      failure: asNumber(await counterValue("auth_attempts_total", { outcome: "failure" })),
    };

    // /request-token has NINE outcome points across the multi-user and
    // single-user paths. The handler counts from the status code on `finish`,
    // so a branch added later is counted without having to remember; this
    // asserts the two values that mapping can produce.
    for (const status of [403, 401, 401, 200, 401, 200])
      safeObserve("auth_attempts_total", {
        outcome: status === 200 ? "success" : "failure",
      });

    expect(await counterValue("auth_attempts_total", { outcome: "success" })).toBe(
      before.success + 2
    );
    expect(await counterValue("auth_attempts_total", { outcome: "failure" })).toBe(
      before.failure + 4
    );
  });
});

describe("chats_total and embeddings_total carry a mapped provider", () => {
  it("records the mapped label, never the raw provider string", async () => {
    const before = asNumber(await counterValue("chats_total", { provider: "other" }));
    // `ppio` is a real provider the resolver accepts and the vocabulary does
    // not; it must be counted, under `other`.
    safeObserve("chats_total", { provider: providerLabel("ppio") });
    expect(await counterValue("chats_total", { provider: "other" })).toBe(
      before + 1
    );
    expect(await counterValue("chats_total", { provider: "ppio" })).toBeNull();
  });

  it("labels embeddings from EMBEDDING_ENGINE, not from the chat provider", async () => {
    // A common install runs a hosted LLM against the bundled native embedder;
    // labelling embeddings with the chat provider would report a provider that
    // computed none of them.
    const before = asNumber(await counterValue("embeddings_total", { provider: "native" }));
    safeObserve("embeddings_total", { provider: providerLabel("native") });
    expect(await counterValue("embeddings_total", { provider: "native" })).toBe(
      before + 1
    );
  });
});

describe("a metrics failure does not break the request (ruling 1)", () => {
  it("swallows the throw and continues", () => {
    // observe() throws by design. Inside a chat handler that would turn a
    // metrics bug into a user-visible 500 — the observability breaking the
    // thing it observes.
    expect(() => observe("chats_total", { provider: "not-a-label" })).toThrow();
    expect(() => safeObserve("chats_total", { provider: "not-a-label" })).not.toThrow();
  });

  it("logs the metric and label NAME, and never the rejected value", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      safeObserve("chats_total", { provider: "acme-legal-due-diligence" });
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls.flat().join(" ");
      expect(logged).toContain("chats_total");
      expect(logged).toContain("provider");
      // The rejected value is by definition one that was not supposed to be
      // published; writing it into a log to explain why it was not published is
      // the same leak one file over.
      expect(logged).not.toContain("acme-legal-due-diligence");
      expect(logged).not.toContain("acme");
    } finally {
      warn.mockRestore();
    }
  });

  it("says nothing at all on the paths that succeed (TL-2 NIT)", () => {
    // The once-per-process memory makes a noisy wrapper hard to notice: it
    // would log once and then go quiet, looking like a single stray line rather
    // than a wrapper that complains about every valid call.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      safeObserve("chats_total", { provider: "openai" });
      safeObserve("embeddings_total", { provider: "native" });
      safeObserve("documents_total", { outcome: "success" });
      safeObserve("auth_attempts_total", { outcome: "failure" });
      const said = warn.mock.calls.flat().join(" ");
      expect(said).not.toContain("[metrics]");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns ONCE per metric and label name, not once per rejected value", () => {
    // Keyed on the label NAME: an install whose provider does not map would
    // otherwise log on every chat, and keying on the VALUE would make the
    // memory unbounded — the same cardinality problem one layer down.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      safeObserve("chats_total", { provider: "bad-one" });
      safeObserve("chats_total", { provider: "bad-two" });
      safeObserve("chats_total", { provider: "bad-three" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the wiring sits where every path goes through it", () => {
  const fs = require("fs");
  const path = require("path");
  const read = (rel) =>
    fs.readFileSync(path.join(__dirname, "../../../", rel), "utf8");

  it("counts /request-token from the status code, covering all nine outcome points", () => {
    // TL-2 F-3. The handler has NINE outcome points across the multi-user and
    // single-user paths — six refusals (SSO disabled, no such user, bad
    // password, suspended, ruling-C, no AUTH_TOKEN / wrong token) and three
    // successes. Counting at each site means a tenth, added later, is counted
    // nowhere; a suspended-account or ruling-C refusal that goes uncounted
    // makes a brute-force attempt invisible in exactly the metric meant to show
    // it. The status code is what every branch already sets and cannot forget.
    const source = read("endpoints/system.js");
    const handler = source.slice(source.indexOf('"/request-token"'));
    expect(handler).toMatch(/response\.on\("finish"/);
    expect(handler).toMatch(/auth_attempts_total/);
    expect(handler).toMatch(/statusCode === 200 \? "success" : "failure"/);
  });

  it("counts the branch that enters NEITHER array (QA-2)", () => {
    // `prisma.workspace_documents.create` can throw after the vector write
    // succeeded: the document is neither `embedded` nor `failedToEmbed`. A
    // counter wired from the two arrays would report two outcomes for a batch
    // of three, and the missing one would read as a smaller batch rather than
    // a partial failure.
    const source = read("models/documents.js");
    // THREE outcome sites, not two: the two pushes plus this branch.
    expect(source.match(/documents_total/g) ?? []).toHaveLength(3);

    // The increment sits inside the catch that reports "Failed to save
    // document record", which is the branch in question.
    const saveFailure = source.slice(
      source.indexOf("await prisma.workspace_documents.create")
    );
    const catchBody = saveFailure.slice(
      saveFailure.indexOf("} catch (error) {"),
      saveFailure.indexOf("Failed to save document record")
    );
    expect(catchBody).toContain('outcome: "failure"');
  });

  it("counts the suspended branch like every other refusal (QA-2)", () => {
    // The INVERSE oracle: if `suspended` were the one refusal that did not
    // increment, a caller watching auth_attempts_total{outcome="failure"} learns
    // that the account exists AND is suspended precisely by the counter NOT
    // moving. Silence is as much a signal as a count.
    //
    // The `finish` hook is what makes this true by construction rather than by
    // remembering: every branch sets a status code and the hook reads it, so no
    // branch can be the one that forgot — including branches added later.
    const source = read("endpoints/system.js");
    const handler = source.slice(source.indexOf('"/request-token"'));
    const body = handler.slice(0, handler.indexOf("\n  );"));

    // Every outcome point in the handler ends in a status-bearing response...
    const responses = body.match(/response\.status\(\d+\)\.json\(/g) ?? [];
    expect(responses.length).toBeGreaterThanOrEqual(9);

    // ...and there is exactly ONE increment, in the hook, covering all of them.
    expect(body.match(/auth_attempts_total/g) ?? []).toHaveLength(1);
    expect(body.indexOf("auth_attempts_total")).toBeLessThan(
      body.indexOf("response.status(")
    );
  });

  it("counts documents inside the loop, not once from a length", () => {
    // TL-2 F-5: `observe()` takes no value, so a single call cannot record a
    // batch. The increments sit beside the pushes that record each outcome.
    const source = read("models/documents.js");
    expect(source).toMatch(/failedToEmbed\.push[\s\S]{0,400}outcome: "failure"/);
    expect(source).toMatch(/embedded\.push[\s\S]{0,120}outcome: "success"/);
    expect(source).not.toMatch(/documents_total[^)]*length/);
  });

  it("wraps the completion methods rather than the factory call", () => {
    // A counter incremented when a connector is CONSTRUCTED counts intentions:
    // connectors are built on paths that then fail validation and on paths that
    // complete nothing. And in the stream path the count is per COMPLETION, not
    // per token.
    const source = read("utils/helpers/index.js");
    expect(source).toMatch(/getChatCompletion", "streamGetChatCompletion"/);
    // TL-2: count them. `toMatch` passes on ONE `await original`, so a wrapper
    // that lost the embedding half would still look right here.
    expect(source.match(/const result = await original/g) ?? []).toHaveLength(2);
  });
});

describe("a rejected call is not a served one (TL-2 NIT)", () => {
  // Behavioural, not a source read: the increment sits AFTER `await original`,
  // so a rejection must skip it. Wired the other way round — count first, then
  // await — chats_total would report every attempt as a completion, and an
  // instance whose provider was refusing every request would look busy.
  const { getLLMProvider, getEmbeddingEngineSelection } = require("../../../utils/helpers");

  it("does not increment chats_total when the connector rejects", async () => {
    const before = asNumber(await counterValue("chats_total", { provider: "openai" }));
    process.env.LLM_PROVIDER = "openai";
    process.env.OPEN_AI_KEY = "sk-not-a-real-key";
    const connector = getLLMProvider();

    // Replace the underlying call with one that rejects, THROUGH the wrapper
    // the factory already installed.
    const boom = new Error("provider refused");
    connector.openai = {
      chat: { completions: { create: () => Promise.reject(boom) } },
    };

    await expect(connector.getChatCompletion([], {})).rejects.toThrow();
    expect(await counterValue("chats_total", { provider: "openai" })).toBe(
      before === 0 ? null : before
    );
  });

  it("does not increment embeddings_total when embedChunks rejects", async () => {
    // Build the engine, then make the method the FACTORY WRAPPED reject, by
    // replacing what the wrapper calls rather than the wrapper itself — the
    // wrapper binds the original at construction, so this reaches through it.
    const { NativeEmbedder } = require("../../../utils/EmbeddingEngines/native");
    const boom = new Error("embedder refused");
    const spy = jest
      .spyOn(NativeEmbedder.prototype, "embedChunks")
      .mockRejectedValue(boom);

    try {
      const engine = getEmbeddingEngineSelection();
      const before = asNumber(
        await counterValue("embeddings_total", { provider: "native" })
      );

      await expect(engine.embedChunks(["chunk"])).rejects.toThrow("embedder refused");

      expect(
        asNumber(await counterValue("embeddings_total", { provider: "native" }))
      ).toBe(before);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("no label may name why a request failed (TL-2 F-4)", () => {
  it("declares no reason or branch label", () => {
    // /api/metrics is readable without authentication behind an ipAllowlist
    // that is EMPTY on a default install. A `reason` label would turn the
    // scrape into a user-enumeration oracle: "no such user" and "bad password"
    // as separate counters answer, for free, a question the endpoint refuses to
    // answer directly (endpoints/system.js returns the same 401 for both).
    for (const forbidden of ["reason", "branch", "username", "user", "ip", "workspace"])
      expect(ALLOWED_LABEL_NAMES).not.toContain(forbidden);
    expect(ALLOWED_LABEL_NAMES).toEqual(["provider", "outcome"]);
  });

  it("refuses a reason label at the call site", () => {
    expect(() =>
      observe("auth_attempts_total", { outcome: "failure", reason: "no_such_user" })
    ).toThrow(/not allowed/);
  });
});
