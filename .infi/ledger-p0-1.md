# P0-1 decision ledger

Ruling: Document CommonJS/JSDoc class contracts rather than TypeScript declarations — existing provider seams are CommonJS classes with static and instance methods — cost if wrong: implementation teams must translate types or revise all contracts

Ruling: Authorization failures default deny and vector ACL filtering occurs before retrieval — post-filtering can leak content through ranking/context side effects — cost if wrong: some vector providers need adapter work or cannot ship until filter support exists

Ruling: Chat pipeline fixes security-sensitive stage ordering while allowing additional middleware — redaction, ACL, guardrail, and metering order cannot be left to drivers — cost if wrong: rigid ordering may constrain future optimizations

Ruling: Connector checkpoints belong to core orchestration and advance only after content, ACL, and indexing state are durable — driver-owned checkpoints can acknowledge data before secure indexing — cost if wrong: sync throughput is lower and orchestration is more complex

Ruling: Channel delivery retries reuse pipeline output instead of rerunning chat — reruns duplicate cost and may produce inconsistent answers — cost if wrong: durable response storage is required until delivery completes

Ruling: Notification rendering and recipient selection remain in core — transport drivers must not gain data access or policy authority — cost if wrong: provider-native templates need a core adapter
