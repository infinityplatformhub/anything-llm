# Ledger — #90 (O5a: Prometheus metrics at /api/metrics)

Ruling: (PMO 1) O5 is split. This issue is `/metrics` only; the diagnostic bundle is O5b, opened after this gates.
ถ้าผิด: the bundle's review is a security review and this one is not — coupling them holds up an endpoint that is a day's work behind a feature that needs a threat model.

Ruling: (PMO 2) `/api/metrics` is unauthenticated, mounted beside `/ping` so it inherits `ipAllowlist` (`index.js:102`). A scraper reaches it by being on the allowlist, not by holding a key.
ถ้าผิด: a separate port doubles what the operator must firewall and does not compose with the allowlist they already configured; requiring a key means minting one for Prometheus and teaching it bearer auth for a status endpoint.

Ruling: the endpoint's own comment states that an EMPTY `IP_ALLOWLIST` means allow-everything (`requestControls.js:223`), which is the default install, so on an internet-facing box this route is public.
ถ้าผิด: whoever reads this route next concludes it is protected because it sits under `ipAllowlist`, and never learns the default is open. Metrics hold no secrets, but user counts, workspace counts and error rates are an inventory, and an inventory is reconnaissance.

Ruling: the doctor (#74) gains `config.metrics_exposure` — a WARNING when `IP_ALLOWLIST` is empty.
ถ้าผิด: as a blocker it would refuse to boot an instance on a private network that is correctly configured as it is. As nothing at all, the operator meets the exposure only if they read the middleware.

Ruling: no label value may derive from user-supplied text. Both the label NAMES and the VALUES each may take are declared as frozen constants, and `observe()` throws on anything else.
ถ้าผิด: Prometheus labels are unbounded cardinality AND plain text in every scrape, so `chats_total{workspace="acme-legal-due-diligence"}` publishes a customer's deal name to everyone who can read the endpoint. Names alone are not enough — `{provider: workspace.name}` type-checks fine and leaks on the next scrape, which is why the values are closed too.

Ruling: `provider` is a class of integration, never an endpoint or a model name.
ถ้าผิด: an operator's self-hosted URL is as identifying as a workspace title.

Ruling: `observe()` throws on an unregistered metric rather than creating one on first use.
ถ้าผิด: a typo becomes a metric nothing ever reports, which reads as a legitimate zero on a dashboard — worse than an error, because it looks like an answer.

Ruling: the app metrics' labels are checked at DECLARATION as well as on the samples in the registry.
ถ้าผิด: a counter with no samples yet has no labels to inspect, so a new metric could sit in the registry unexercised, with a leaking label, until the first request reaches it.

Ruling: the registry scan is scoped to our own counters via `APP_METRIC_NAMES`, not to everything registered.
ถ้าผิด: prom-client's defaults carry their own labels (`nodejs_active_resources{type}`, `nodejs_heap_space_size_*{space}`, `nodejs_version_info{version,major,...}`) whose values come from the runtime, not from anything a user can type. Holding them to our vocabulary would be asserting on the library and would have to be worked around rather than fixed.

Ruling: `prom-client` pinned exactly at 15.1.3.
ถ้าผิด: a caret range moves the exposition format's library under a feature whose whole contract is the format.

Ruling: the doctor suite's "only non-blocking check" test now ENUMERATES the warnings instead of naming one.
ถ้าผิด: found while adding the check — a new check defaulting to `warn` when it should block would slip past a count, and the level being fixed per check exists so that adding one is a decision.

## Residual

- **No test asserts a real scrape from Prometheus.** The exposition format is prom-client's contract; what is tested here is that the content type is `version=0.0.4` and that the body carries the default process metrics.
- **The counters are declared but not yet wired to call sites.** `observe()` and its vocabulary exist and are enforced; incrementing them from the chat, embedding, document and auth paths is deliberately not in this issue — each call site is a decision about which class a given event belongs to, and doing them here would bury the endpoint's review under a dozen unrelated diffs.
