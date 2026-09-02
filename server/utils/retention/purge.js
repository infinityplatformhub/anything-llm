// T-6 Phase B (#28): delete audit rows past the retention window.
//
// FAIL CLOSED. A missing, empty, zero, negative or unparseable window means "keep
// forever", never "delete now". The audit log is the record of what everyone did,
// and a misread setting must never be the thing that empties it. Every rejected
// value returns {skipped: true} so an operator can tell "nothing was old enough"
// apart from "the window was unusable".
//
// The purge DELETES, it does not archive. If archive-before-delete is ever needed,
// that is a separate job feeding the export path, and it has to land BEFORE any
// window is shortened.

const prismaDefault = require("../prisma");
const { deleteAuditEvents } = require("../events/AuditEventSubscriber");
const { IdentityLoginState } = require("../../models/identityLoginState");

const RETENTION_LABEL = "audit_retention_days";
const DEFAULT_BATCH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @returns {number|null} whole days to keep, or null when the value is unusable
 *   and the purge must do nothing.
 */
function parseRetentionDays(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  // Number() accepts "", " ", "0x10" and "1e3"; a strict decimal test keeps the
  // window to values an operator can read back off the settings row.
  if (!/^\d+$/.test(text)) return null;
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days <= 0) return null;
  return days;
}

async function readRetentionDays(db) {
  const row = await db.system_settings.findFirst({
    where: { label: RETENTION_LABEL },
    select: { value: true },
  });
  return parseRetentionDays(row?.value ?? null);
}

/**
 * Delete event_logs older than the configured window.
 *
 * Batched so a first run against a large table does not hold one enormous
 * transaction. The cutoff is computed ONCE, before the loop: recomputing it per
 * batch would move the boundary during a long run and make the job's result
 * depend on how long it took.
 *
 * @returns {Promise<{purged: number, skipped: boolean, retentionDays: number|null, cutoff: string|null}>}
 */
async function purge({
  db = prismaDefault,
  batchSize = DEFAULT_BATCH,
  now = () => new Date(),
} = {}) {
  // S1 (#36, Q-3): in-flight SSO logins expire on their OWN 15-minute clock, not
  // the audit window, so this runs first and independently. It must survive an
  // unusable audit window — the two are unrelated, and an operator who never set
  // audit retention would otherwise grow this table on every login attempt,
  // including unauthenticated ones.
  const loginStatesPurged = await IdentityLoginState.purgeExpired({
    db,
    now: now(),
  });

  const retentionDays = await readRetentionDays(db);
  if (retentionDays === null)
    return {
      purged: 0,
      skipped: true,
      retentionDays: null,
      cutoff: null,
      loginStatesPurged,
    };

  const cutoff = new Date(now().getTime() - retentionDays * DAY_MS);
  let purged = 0;
  for (;;) {
    // Select then delete by primary key. deleteMany has no LIMIT, so batching has
    // to name the rows; deleting by id also means a row written after the cutoff
    // was computed is never caught by a later batch of the same run.
    const batch = await db.event_logs.findMany({
      where: { occurredAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize,
    });
    if (batch.length === 0) break;

    // Through deleteAuditEvents, not a direct deleteMany: event_logs has exactly
    // one sanctioned mutation path, and the boundary test enforces it. A purge
    // that wrote around it would be the second writer that rule exists to prevent.
    const count = await deleteAuditEvents(
      { id: { in: batch.map((row) => row.id) } },
      db
    );
    purged += count;
    // A batch that selected rows but deleted none would otherwise spin forever —
    // a concurrent purge already took them, and there is nothing left to do.
    if (count === 0) break;
  }

  return {
    purged,
    skipped: false,
    retentionDays,
    cutoff: cutoff.toISOString(),
    loginStatesPurged,
  };
}

module.exports = { purge, parseRetentionDays, RETENTION_LABEL, DEFAULT_BATCH };
