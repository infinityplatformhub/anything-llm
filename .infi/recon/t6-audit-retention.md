# T-6 recon — audit export + retention job + PDPA redaction hook

Baseline: `approof/main` @ `7dce4997`. Depends on P0-6 (job queue + event bus, merged) and T-1/T-2 (authorization, merged). Independent of PR-4b/4c in files.

## What already exists (do not rebuild)

- `server/utils/jobs/PostgresJobQueue.js` — enqueue / schedule / claim / retry / dead-letter, leases, idempotency keys.
- `server/utils/jobs/PostgresJobScheduler.js` — cron → `job_schedules.nextRunAt`, advisory-locked `materialize()`.
- `server/utils/jobs/handlers.js` — **already has a `retention.purge@1` stub and a `retention-purge-daily` schedule at `0 2 * * *` UTC.** T-6 fills the stub; it does not add a schedule.
- `server/utils/events/` — `PostgresEventBus`, `OutboxPump`, `AuditEventSubscriber`; `emitAuditEvent(event, metadata, userId, opts)` is the only sanctioned write path to `event_logs`.
- `server/models/eventLogs.js` — read helpers (`whereWithData`, `count`, `getByEvent`, `getByUserId`).

## Owner files

**New**
- `server/utils/retention/policy.js` — resolve retention window per event class; env-driven, defaults documented.
- `server/utils/retention/purge.js` — the actual delete, batched, transactional, emits its own audit event.
- `server/utils/retention/redaction.js` — PDPA pattern hook (below).
- `server/utils/audit/export.js` — streaming export of `event_logs` to NDJSON/CSV.
- `server/endpoints/api/audit/index.js` — export + query endpoints.
- `server/__tests__/utils/retention/purge.postgres.test.js`
- `server/__tests__/utils/retention/redaction.test.js`
- `server/__tests__/utils/audit/export.test.js`

**Modified**
- `server/utils/jobs/handlers.js` — `retention.purge@1` calls the real purge; add `audit.export@1` for large async exports.
- `server/prisma/schema.prisma` — `event_logs` gains `redactedAt`, `retentionClass`; new `audit_exports` table.
- `server/utils/events/AuditEventSubscriber.js` — run the redaction hook before insert.

## Migration slot

Per code-standards §1.2 the next free hour after `20260902031000_browser_key_digest` is `20260902040000`. **PR-4c also wants that slot** (see `pr4c.md`). Whichever branch opens second takes `20260902050000`. Claim on branch open, not on first migration — say which one you took in the PR title.

Contents:
1. `event_logs.retentionClass String @default("standard")` — nullable-free, so the purge has a total function over every row.
2. `event_logs.redactedAt DateTime? @db.Timestamptz(3)` — timestamptz per §1.1, never naive.
3. New `audit_exports` — `id`, `requestedBy`, `filters`, `state`, `rowCount`, `path`, `expiresAt` (all timestamps timestamptz), so an export is itself an auditable object.
4. Index `event_logs(occurredAt)` — the purge's where clause. Without it the daily job table-scans and gets slower every day.

## Retention policy

Three classes, resolved by event name prefix:

| Class | Events | Default window | Env |
|---|---|---|---|
| `security` | `auth.*`, `api_key_*`, `sso.*`, authorization denials | 365d | `RETENTION_SECURITY_DAYS` |
| `standard` | everything else | 90d | `RETENTION_STANDARD_DAYS` |
| `content` | anything carrying `sensitivity:"content"` (seam 10 §38) | 30d | `RETENTION_CONTENT_DAYS` |

Two rulings to make explicit in the PR body, because both are the kind of thing a reviewer will ask and a silent choice will be wrong:

- **Purge deletes, it does not archive.** If the product needs archive-before-delete, that is a second job (`retention.archive@1`) feeding the export path, and it must land *before* purge shortens any window.
- **A zero or unset window means "keep forever", not "delete now".** Fail closed. A misread env must never be the thing that empties the audit log.

## PDPA redaction hook

Redaction happens **on write**, in `AuditEventSubscriber`, before the row exists — not as a later sweep. A sweep leaves the raw value on disk and in WAL between write and sweep, which defeats the point.

```js
// redaction.js
const PATTERNS = [
  { name: "thai_national_id", re: /\b\d{13}\b/g },
  { name: "email",           re: /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { name: "phone_th",        re: /\b0\d{8,9}\b/g },
  { name: "credit_card",     re: /\b(?:\d[ -]*?){13,16}\b/g },
];
function redact(metadata) { /* returns { metadata, redactions: ["email", ...] } */ }
```

Rules for whoever implements it:
- Redaction runs over the serialized `metadata` only. It must **never** touch `event`, `eventId`, `userId`, or `occurredAt` — those are the join keys and an audit log whose keys are redacted is not an audit log.
- The replacement records *what class* was removed (`[redacted:email]`), never the original or a hash of it. A hash is a rainbow-table lookup for a 13-digit ID.
- Set `redactedAt` when at least one pattern fired, so a compliance query can find affected rows without re-scanning content.
- Patterns are additive and env-extensible, but the four above are the floor and cannot be disabled by config.

## Audit export

- `GET /v1/audit/events` — paginated read, filters `event`, `userId`, `from`, `to`. Scope `audit.read`.
- `POST /v1/audit/export` — enqueues `audit.export@1`, returns the `audit_exports` row. Scope `audit.export`.
- `GET /v1/audit/export/:id` — status + download when ready. Scope `audit.export`.

Both scopes are **new** and belong in `scopes.js` alongside PR-4b's additions. `audit.export` must be separate from `audit.read` — export is bulk exfiltration of exactly the data most worth stealing, and T-2's security review already flagged the equivalent on chat export.

Export writes NDJSON streamed row-by-row. Do not build the array in memory; the whole premise is that this table is large.

**The export is itself an audited action**: emit `audit.exported` with the filters and row count. An audit system whose export leaves no trace has a hole shaped exactly like an attacker.

## RED DoD

Write these tests first; they must fail before the implementation exists.

1. **Purge deletes only what is past its window.** Seed `event_logs` with rows straddling each class boundary (one second either side), run the handler, assert exactly the expected ids survive. Real Postgres — the boundary is a `timestamptz` comparison and a fake db proves nothing about it (§7.1).
2. **Purge is idempotent and batched.** Run twice; second run deletes 0 and does not error. Seed above the batch size and assert every eligible row is gone after one invocation, not just the first batch.
3. **Purge fails closed.** With `RETENTION_STANDARD_DAYS` unset, empty, `0`, and `"abc"`, the handler deletes nothing and does not throw. Four cases, one test.
4. **Redaction on write.** Emit an audit event whose metadata contains each of the four patterns; assert the stored row contains none of the originals, contains the class markers, and has `redactedAt` set. Assert `event`/`userId`/`eventId` are unchanged.
5. **Export completeness.** Seed N rows, export with a filter, assert the NDJSON line count equals the count the same filter returns via `EventLogs.count`, and that an `audit.exported` event was recorded.
6. **Scope enforcement.** A key with `audit.read` gets 403 on `POST /v1/audit/export`; a key with `audit.export` gets 200. (Skip if T-6 opens before PR-4b lands — then it is a PR-4b follow-up, say so.)
7. **Boot DoD per §7.2 — ≥3 ticks.** Boot the real server against real Postgres with the scheduler running and a `retention.purge` schedule set to a fast cron, and assert **three** materializations produce three distinct `jobs` rows with advancing `nextRunAt` and no duplicate `idempotencyKey`. One tick proves the cron parsed; three prove the advisory lock, the `Math.max` catch-up ruling, and idempotency all hold under repetition. This is the specific test class that the `pg_advisory_xact_lock` incident existed to force — do not substitute a unit test with a fake `$transaction`.

## Sequencing

Independent of PR-4b/4c in files; shares only `scopes.js` (two new entries) and the migration hour. Can start immediately. If both T-6 and PR-4c are assigned at once, give T-6 the later slot — PR-4c's migration is a one-line `ALTER COLUMN` and should land fast.

## §PMO rulings (start now, subagent dev-28)
- Owner reassigned from Dev3 (#15 still open) to subagent dev-28.
- Phase A (start now, no collision): AuditEventSubscriber.handle redaction at the sink — allowlist of keys + PDPA pattern scan (email / TH phone / 13-digit ID) on string values; `changes` never stores prev→next for PII fields; sentinel-at-handle test. New audit export endpoint in NEW file server/endpoints/audit/index.js (requirePermission("audit.read"…) — verify action exists in seed; add via slot 050000 if missing) mounted from endpoints index; CSV/JSON export with redaction applied; HTTP test. Migration slot 20260902050000 for retention settings + audit.read if needed.
- Phase B (ONLY after #29 t4b merges — jobs/ files in flight): fill retention.purge@1 body in server/jobs/handlers.js (existing schedule 0 2 * * *, do not add one); §7.2 DoD boot prod ≥3 ticks + DB state (reuse QA-1 harness /tmp/t6base/boot-harness.sh); idempotent; purge respects per-org retention setting.
- Do not touch endpoints/system.js, endpoints/admin.js, utils/helpers/admin (T-7), utils/jobs/** or jobs/handlers.js until t4b merged, engine/actorResolver.
- C-1: ENABLE_DOC_VECTORS_CANONICALIZE flip + 7 provider legacy docId sites remain T-6 Phase B scope after t4b/T-5 land.
