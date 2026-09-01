# Ledger — issue 28 (T-6 Phase A)

Ruling: Redaction is an ALLOWLIST of data keys plus a pattern scan, not a denylist — the live regression was a hardcoded sensitiveFields=["password"] at one call site in models/user.js, which protects against the payload someone thought of and nothing else; an unknown key is dropped and its name recorded under _droppedKeys — if wrong, a legitimate new key silently loses its value until someone adds it to the allowlist, which is visible in the stored row rather than silent.

Ruling: The allowlist was derived mechanically from all 71 emitAuditEvent call sites in server/endpoints, server/models and server/utils rather than written from the recon list — the recon named roughly 40 sites and the tree has 71; if wrong, a key in use today is dropped, which the full suite would surface as a changed audit assertion.

Ruling: Four PDPA patterns are ordered thai_national_id before credit_card so a 13-digit Thai ID is classified as an ID rather than swallowed by the card pattern — if wrong, the marker names the wrong class while the raw value is removed either way, so the leak is closed and only the label is imprecise.

Ruling: `changes` gets its own handler that stores "[redacted:changed]" for PII fields instead of the prev-to-next pair — storing both halves of a password or email change doubles the leak rather than recording it; if wrong, an operator loses the ability to see what an email changed from, which is the trade PDPA asks for.

Ruling: The export redacts on READ as well as on write — rows written before this landed were stored raw, so a reader trusting the stored value would hand out exactly the PII the sink now removes; if wrong, the cost is redundant work on already-clean rows.

Ruling: The action is named `audit.read` and granted to super_admin ONLY via migration 20260902050000 — grep of server/prisma/seeds/permissions.js found no existing audit action, so R3 forbids no duplicate here; system.read was rejected because it is held by keys that report status and the audit trail is the record of what administrators did. If wrong, an operator who should export has to be granted super_admin, which is visible and reversible.

Ruling: Export reads with a MAX_ROWS cap of 50000 and serializes in memory rather than streaming NDJSON as the recon specified — the streaming premise depends on the table being unbounded, and what bounds it is the retention purge that Phase B fills; marked with a ponytail note naming the upgrade path. If wrong, a deployment with more than 50000 rows gets a truncated export rather than an error, which the cap makes visible in rowCount.

Ruling: Phase B (retention.purge@1 body, boot DoD, C-1 flag) is NOT in this run per the PMO ruling — jobs/ files are in flight on issue 29. No file under utils/jobs, jobs/handlers.js, endpoints/system.js, endpoints/admin.js, utils/helpers/admin, engine.js or actorResolver.js was touched.

Ruling: vocabulary-diff.test.js was updated from 61 to 62 actions — it asserts an exact count as the guard against an unreviewed vocabulary addition, so adding an action means updating it deliberately, which is the mechanism working rather than a test being bent.
