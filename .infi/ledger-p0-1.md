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
