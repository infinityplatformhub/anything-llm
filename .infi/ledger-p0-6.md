# P0-6 ledger

Ruling: Implement queue directly on Prisma/Postgres rather than add pg-boss — binding contract needs custom immutable ActorRef, leasing, and dead-letter semantics; existing Prisma and pg dependencies suffice — if wrong, scheduler maintenance costs more than pg-boss adoption.
Ruling: Keep P0-6 Prisma models in delimited final schema block and separate migration — P0-2 owns provider and base migration — if wrong, rebase may need manual migration consolidation.
Ruling: Develop and unit-test drivers through injected Prisma-compatible stores, with Postgres DDL supplied separately — parallel P0-2 branch owns runnable Postgres test substrate — if wrong, SQL-specific lease behavior needs follow-up integration fixes after rebase.
Ruling: Preserve EventLogs.logEvent as compatibility delegate but migrate production call-sites to emitAuditEvent — external plugins may still import model API — if wrong, compatibility surface hides a forbidden direct call.
Ruling: Audit delivery runs immediately after non-transactional publish to preserve existing await semantics; transactional publishers rely on outbox pump — if wrong, transactional audit visibility is delayed until worker tick.
Ruling: Retention purge handler logs and returns zero only — S6 owns authorization and deletion policy — if wrong, placeholder may imply more governance coverage than exists.
