// T-6 Phase A (#28): audit log export.
//
// The export applies the SAME redaction as the write path. Rows written before
// T-6 landed were stored unredacted, so a reader that trusted the stored value
// would hand out exactly the PII the sink now removes. Redacting again on read is
// cheap and makes the export total over the table's history rather than over the
// part of it written since this shipped.
//
// The export is itself an audited action: it emits `exported_chats`-shaped
// evidence of who exported what. An audit system whose export leaves no trace has
// a hole shaped exactly like an attacker.

const { EventLogs } = require("../../models/eventLogs");
const { emitAuditEvent } = require("../../utils/events");
const { redactEventData } = require("../../utils/events/redaction");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const { requirePermission } = require("../../utils/middleware/requirePermission");
const { orgResource } = require("../../utils/middleware/resourceResolvers");

const FORMATS = new Set(["json", "csv"]);
const COLUMNS = ["id", "eventId", "event", "userId", "occurredAt", "metadata"];
// ponytail: a whole-table export is read in one query and serialized in memory.
// That holds while event_logs is bounded by the retention purge; T-6 Phase B fills
// `retention.purge@1`, which is what keeps it bounded. Stream row-by-row (NDJSON)
// when a deployment carries more rows than MAX_ROWS.
const MAX_ROWS = 50000;

/** A bad `from`/`to` is a client error, not an empty export that looks like no data. */
function parseRange(request) {
  const clause = {};
  for (const [field, bound] of [["from", "gte"], ["to", "lte"]]) {
    const raw = request.query?.[field];
    if (raw === undefined || raw === "") continue;
    const at = new Date(String(raw));
    if (Number.isNaN(at.getTime()))
      return { error: `Invalid ${field} timestamp.` };
    clause[bound] = at;
  }
  return { where: Object.keys(clause).length ? { occurredAt: clause } : {} };
}

/** Redact on read too — rows predating T-6 were stored raw. */
function redactRow(row) {
  let metadata = row.metadata;
  if (typeof metadata === "string" && metadata.length) {
    try {
      metadata = JSON.stringify(redactEventData(JSON.parse(metadata)).data);
    } catch {
      // Not JSON: scan it as a bare string rather than trusting it through.
      metadata = redactEventData(metadata).data;
    }
  }
  return { ...row, metadata };
}

// CSV formula injection. Excel, Sheets and LibreOffice evaluate a cell whose text
// begins with = + - or @, so an event type of `=cmd()|...!A1` becomes code the
// moment an operator opens the export. Every column here is caller-influenced —
// the event TYPE is a data column and comes straight from the emitter — so the
// guard is applied to every cell rather than to the ones that look risky.
//
// Leading whitespace and control characters are skipped before the test, because a
// spreadsheet ignores them when deciding whether a cell is a formula. The
// apostrophe prefix is what tells it to treat the rest as literal text.
const FORMULA_LEAD = new RegExp("^[\\s\\u0000-\\u001f]*[=+\\-@]");

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_LEAD.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  const lines = [COLUMNS.join(",")];
  for (const row of rows)
    lines.push(COLUMNS.map((column) => csvCell(row[column])).join(","));
  return lines.join("\n");
}

function auditEndpoints(app) {
  if (!app) return;

  app.get(
    "/audit/export",
    [validatedRequest, requirePermission("audit.read", orgResource)],
    async (request, response) => {
      try {
        const format = String(request.query?.format ?? "json").toLowerCase();
        if (!FORMATS.has(format))
          return response
            .status(400)
            .json({ error: "format must be json or csv." });

        const range = parseRange(request);
        if (range.error) return response.status(400).json({ error: range.error });

        const rows = (
          await EventLogs.where(range.where, MAX_ROWS, { occurredAt: "desc" })
        ).map(redactRow);

        await emitAuditEvent(
          "audit_exported",
          { type: format, numberOfDocuments: rows.length },
          response.locals?.user?.id ?? null
        );

        if (format === "csv") {
          response.setHeader("Content-Type", "text/csv; charset=utf-8");
          response.setHeader(
            "Content-Disposition",
            'attachment; filename="audit-export.csv"'
          );
          return response.status(200).send(toCsv(rows));
        }
        return response.status(200).json({ rows, rowCount: rows.length });
      } catch (error) {
        console.error("[audit-export]", error.message);
        return response.sendStatus(500);
      }
    }
  );
}

module.exports = { auditEndpoints };
