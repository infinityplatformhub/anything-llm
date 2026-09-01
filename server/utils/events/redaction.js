// T-6 Phase A (#28): PDPA redaction at the audit sink.
//
// Redaction happens ON WRITE, in AuditEventSubscriber, before the row exists. A
// later sweep leaves the raw value on disk and in the WAL between write and sweep,
// which defeats the point.
//
// Two independent guards, because each catches what the other cannot:
//
//   1. An ALLOWLIST of data keys. Derived from every emitAuditEvent call site in
//      the tree. A denylist protects against the payloads someone thought of; an
//      allowlist protects against the ones they did not. The live regression that
//      forced this is models/user.js, where the only guard was a hardcoded
//      sensitiveFields=["password"] at ONE call site — a second call site passing
//      a password would have stored it verbatim.
//   2. A PATTERN SCAN over every string value, at any depth. An allowlisted key
//      still carries free text: `bio`, `prevSystemPrompt`, `username`. A key being
//      permitted says nothing about what a user typed into it.
//
// What is NEVER touched: event, eventId, userId, occurredAt. Those are the join
// keys, and an audit log whose keys are redacted is not an audit log.

// Every key passed as the `data` argument of emitAuditEvent across the tree
// (71 call sites, scanned 2026-09-02). A new call site introducing a key that is
// not here has its value DROPPED, not stored — adding the key here is a
// deliberate act, which is the point.
const ALLOWED_KEYS = new Set([
  // actors and naming
  "username", "userName", "createdBy", "deletedBy", "name", "userId",
  // workspaces, threads, chats
  "workspaceName", "workspaceId", "workspace", "threadName", "thread",
  "chatModel", "type", "chatType",
  // documents and files
  "documentName", "filename", "folder", "link",
  "numberOfDocumentsAdded", "numberOfDocuments",
  "embeddedFiles", "failedFiles", "embedded", "failed",
  // prompts
  "prevSystemPrompt", "newSystemPrompt",
  // user updates
  "changes",
  // invites, embeds, community hub
  "inviteCode", "embedId", "itemId", "itemType",
  // auth and keys
  "ip", "multiUserMode", "scopedKeyId", "keyPrefix", "action", "allowed", "orgId",
  // integrations
  "bot_username", "chatId", "feature", "reason",
]);

// PDPA patterns. These four are the floor and cannot be disabled by config.
// Order matters: thai_national_id runs before credit_card so a 13-digit ID is
// classified as an ID rather than swallowed by the card pattern.
const PATTERNS = [
  { name: "thai_national_id", re: () => /\b\d{13}\b/g },
  { name: "credit_card", re: () => /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g },
  { name: "email", re: () => /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { name: "phone_th", re: () => /\b0\d{8,9}\b/g },
];

// Fields whose BEFORE value is as sensitive as its after value. `changes` stores
// "prev => next"; for these, storing the pair doubles the leak instead of
// recording it. The class marker says a change happened without saying to what.
const PII_CHANGE_FIELDS = new Set([
  "password", "email", "username", "phone", "phoneNumber",
  "nationalId", "citizenId", "pfpFilename",
]);

const MAX_DEPTH = 8;

/** Replace every pattern hit in a string with its class marker. */
function scrubString(value, hits) {
  let out = value;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re(), () => {
      hits.add(name);
      return `[redacted:${name}]`;
    });
  }
  return out;
}

function scrubValue(value, hits, depth) {
  if (typeof value === "string") return scrubString(value, hits);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) {
    hits.add("depth_limit");
    return "[redacted:depth_limit]";
  }
  if (Array.isArray(value))
    return value.map((entry) => scrubValue(entry, hits, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value))
    out[key] = scrubValue(entry, hits, depth + 1);
  return out;
}

/** `changes` is prev-to-next pairs; PII fields keep the fact, lose both values. */
function scrubChanges(changes, hits, depth) {
  if (changes === null || typeof changes !== "object" || Array.isArray(changes))
    return scrubValue(changes, hits, depth);
  const out = {};
  for (const [field, value] of Object.entries(changes)) {
    if (PII_CHANGE_FIELDS.has(field)) {
      hits.add("pii_change_field");
      out[field] = "[redacted:changed]";
      continue;
    }
    out[field] = scrubValue(value, hits, depth + 1);
  }
  return out;
}

/**
 * @param {any} data the emitAuditEvent `data` argument
 * @returns {{data: any, redactions: string[], dropped: string[]}}
 *   `redactions` names the classes that fired; `dropped` names the keys the
 *   allowlist refused. Both are empty when nothing was removed.
 */
function redactEventData(data) {
  const hits = new Set();
  const dropped = [];
  if (data === null || data === undefined)
    return { data, redactions: [], dropped };
  if (typeof data !== "object" || Array.isArray(data))
    return { data: scrubValue(data, hits, 0), redactions: [...hits].sort(), dropped };

  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_KEYS.has(key)) {
      dropped.push(key);
      continue;
    }
    out[key] = key === "changes" ? scrubChanges(value, hits, 0) : scrubValue(value, hits, 0);
  }
  if (dropped.length) out._droppedKeys = dropped.slice().sort();
  return { data: out, redactions: [...hits].sort(), dropped };
}

module.exports = {
  redactEventData,
  ALLOWED_KEYS,
  PATTERNS,
  PII_CHANGE_FIELDS,
};
