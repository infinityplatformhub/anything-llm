# P0-1 decision ledger

Ruling: Document CommonJS/JSDoc class contracts rather than TypeScript declarations — existing provider seams are CommonJS classes with static and instance methods — cost if wrong: implementation teams must translate types or revise all contracts

Ruling: Authorization failures default deny and vector ACL filtering occurs before retrieval — post-filtering can leak content through ranking/context side effects — cost if wrong: some vector providers need adapter work or cannot ship until filter support exists

Ruling: Chat pipeline fixes security-sensitive stage ordering while allowing additional middleware — redaction, ACL, guardrail, and metering order cannot be left to drivers — cost if wrong: rigid ordering may constrain future optimizations

Ruling: Connector checkpoints belong to core orchestration and advance only after content, ACL, and indexing state are durable — driver-owned checkpoints can acknowledge data before secure indexing — cost if wrong: sync throughput is lower and orchestration is more complex

Ruling: Channel delivery retries reuse pipeline output instead of rerunning chat — reruns duplicate cost and may produce inconsistent answers — cost if wrong: durable response storage is required until delivery completes

Ruling: Notification rendering and recipient selection remain in core — transport drivers must not gain data access or policy authority — cost if wrong: provider-native templates need a core adapter

Ruling: Vector ACL is a required argument with no nullable or admin bypass form — optional filters guarantee an eventual leak at an old call site — cost if wrong: every existing vector query call site needs migration

Ruling: Providers lacking secure ACL filtering are rejected rather than post-filtered — forbidden candidates must never cross the seam — cost if wrong: fewer vector backends are available at ACL launch

Ruling: License signature verification is fully offline and feature checks remain separate from authorization — air-gap is required and purchased entitlement is not permission — cost if wrong: callers perform two checks and need coherent error mapping

Ruling: Postgres is first queue and event-bus substrate — Phase 0 already mandates Postgres and Redis would add operations cost — cost if wrong: high queue volume later requires migration

Ruling: Event delivery is durable at-least-once through transactional outbox — audit cannot disappear after business commit — cost if wrong: every subscriber must be idempotent and storage grows until retention

Ruling: Storage keys are typed tenant-scoped values and no driver returns public URLs — authorization remains above storage and tenant isolation is structural — cost if wrong: direct filesystem callers require migration and downloads need an app streaming endpoint

Ruling: Sequence diagrams may show thin core orchestration boxes but no provider or durable side effect may bypass a named seam — business workflows need coordination while seams own replaceable capabilities — cost if wrong: an additional application-service seam would be needed and all diagrams/contracts revised

Ruling: Emergency hide changes vector visibility synchronously before success and queues physical cleanup — breach containment cannot wait for reindex — cost if wrong: vector drivers need immediate metadata/filter updates and may require a shadow deny list

Ruling: Offboarding reauthorizes queued transfer at execution and releases seat only after transfer — permissions and destination ownership can change while work waits — cost if wrong: deactivated seats remain occupied during long or repeatedly failing transfers

Ruling: Directory sync is capability-flagged on identity providers, with Lark as first capable driver and OIDC login-only by default — login refresh cannot detect users who never return after departure — cost if wrong: identity seam carries optional methods not needed by basic providers

Ruling: Connector ACL revision has an independent delta/checkpoint path plus mandatory full ACL resweep at least every 24 hours — source permission removal may not change content metadata — cost if wrong: non-delta connectors perform costly full permission reads and leakage window is bounded rather than zero

Ruling: Embed visitors are explicit `embed` actors, consume no seat, inherit no user/group grants, and receive only verified key-scoped attribute/bounded-document ACLs — anonymous traffic is neither human seat nor privileged service identity — cost if wrong: per-seat contract may need an embed concurrency/add-on claim later

Ruling: Impersonation provenance is immutable across authorization, jobs, and events; viewed identity is `onBehalfOf`, real admin is `impersonatedBy`, and sessions are read-only — view-as-user needs accurate audit without privilege-bearing mutation — cost if wrong: support workflows needing changes must exit impersonation and reproduce action separately

Ruling: Authorization engine owns `explainAccess` backed by same policy evaluator and reverse index — document diagnostics require resource-to-principal answers that forward checks cannot reconstruct cheaply — cost if wrong: policy writes and migrations must maintain reverse-queryable data

Ruling: Budget operations extend license gate instead of adding twelfth seam — entitlement, seats, and paid usage ceilings share enforcement ownership while preserving eleven planned contracts — cost if wrong: license driver becomes broader and budget may later split into its own service

Ruling: Pipeline owns per-request abort controller and every model chunk crosses ordered middleware hooks — output guards and token ceilings must stop provider and delivery mid-stream — cost if wrong: streaming adds serial middleware/counter latency per chunk

Ruling: Multi-namespace vector search globally merges normalized authorized results and returns one global topN — organization search must rank across workspaces rather than return topN from each — cost if wrong: providers need over-fetch and stable merge work

Ruling: Vector ACL production filters prefer denied-only indexed attributes; allowed-document IN lists are bounded scopes only — organization-sized allow lists do not scale in Lance or remote providers — cost if wrong: vector metadata duplicates grant attributes and ACL changes require metadata updates

Ruling: `setDocumentVisibility` is metadata/index-only — emergency containment must not rewrite embeddings or canonical ACL/content — cost if wrong: providers without mutable metadata need a shadow visibility deny index

Ruling: Sequence review lives at `docs/superpowers/design/00-sequence-review.md` — seam directory evidence must count exactly eleven contracts — cost if wrong: references expecting review beside contracts need path updates
