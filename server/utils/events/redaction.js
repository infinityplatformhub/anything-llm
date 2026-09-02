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
  // invites, embeds, community hub.
  //
  // #71: `inviteCode` is NOT here, and must not be added back. An invite code is
  // a bearer credential — `POST /invite/:code` is public, creates an account and
  // joins workspaces — and invites do not expire, so a code in an exported audit
  // log stays redeemable indefinitely. `inviteId` names which invite without
  // carrying anything redeemable, the same trade `keyPrefix` makes for API keys.
  "inviteId", "embedId", "itemId", "itemType",
  // auth and keys
  "ip", "multiUserMode", "scopedKeyId", "keyPrefix", "action", "allowed", "denyReason", "orgId",
  // integrations
  "bot_username", "chatId", "feature", "reason",
  // #48 credential revocation. The VALUE here is a KEY_MAPPING envKey — `OPEN_AI_KEY`,
  // not the secret — and the route refuses anything that is not one, so it cannot carry
  // caller-chosen free text. Naming which credential was revoked is the entire audit
  // value of the event; without it the row says only that something was cleared.
  "envKey",
]);

// PDPA patterns. These four are the floor and cannot be disabled by config.
// Order matters: thai_national_id runs before credit_card so a 13-digit ID is
// classified as an ID rather than swallowed by the card pattern.
//
// The three NUMERIC patterns are bounded by (?<!\d) / (?!\d), NOT by `\b`.
// `\b` needs a non-word character next to the digits, and `_` is a word
// character, so `user_1234567890123` and `note_0812345678` kept their values in
// full — measured while building O5b's bundle scan (#94), where an event name
// carried an ID past the whole-bundle assertion. It is the same failure the
// `credential` pattern below already documents for its own anchor, one class
// over: an anchor that fails open on string concatenation is worse than none.
//
// Digit lookarounds rather than no bound at all, because the bound is doing
// real work: it stops a 16-digit card number from having its first 13 digits
// claimed by thai_national_id and the remainder left in the clear.
const PATTERNS = [
  { name: "thai_national_id", re: () => /(?<!\d)\d{13}(?!\d)/g },
  { name: "credit_card", re: () => /(?<!\d)\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}(?!\d)/g },
  { name: "email", re: () => /[\w.+-]+@[\w-]+\.[\w.]+/g },
  { name: "phone_th", re: () => /(?<!\d)0\d{8,9}(?!\d)/g },
  // #71. Not PDPA — a BEARER CREDENTIAL. Dropping `inviteCode` from the
  // allowlist fixes ONE call site; this fixes the class. The allowlist filters
  // top-level keys only, so a credential still reaches the row through
  // `changes: {code}`, a nested object, an array element, or any allowlisted key
  // that takes free text — `name`, `workspaceName`, and `link`, which carries
  // document URLs at two LIVE call sites (`endpoints/workspaces.js` emitting
  // `link_uploaded`, `endpoints/api/document/index.js` emitting
  // `api_link_uploaded`) and so cannot be removed from the allowlist without
  // losing those audit records. `scrubString` walks every string at every depth,
  // so one value pattern closes all of those paths at once.
  //
  // EVERY issued `apw-*-` credential, not just invites. Today that is `apw-inv-`
  // (invites), `apw-key-` (API keys), `apw-brx-` (browser extension) and
  // `apw-tat-` (temporary auth tokens) — all the same shape, all the same risk,
  // and none of them was guarded. `apw-tat-` was missed by an explicit
  // three-prefix alternation and caught in review, which is the argument for
  // matching the FAMILY rather than a list: the next generator someone adds is
  // covered on the day it is added, instead of leaking until someone notices.
  // The cost is that a non-credential string shaped `apw-xyz-<16 chars>` would
  // also be redacted; nothing in the tree is, and over-redacting a log line is
  // recoverable in a way that publishing a live credential is not.
  //
  // The bound is 16 rather than the 43 these generate today: the `apw-*-` prefix
  // already makes a false positive impossible, and a bound tied to the current
  // length would stop matching the moment a code got shorter — failing open,
  // silently. Kept last so the PDPA classes claim their matches first.
  //
  // NO `\b` ANCHOR, deliberately. `\b` needs a non-word character before the `a`,
  // so a credential concatenated onto anything word-like slips through whole:
  // `token${code}`, `id${code}`, and `_${code}` all survived it (`_` is a word
  // character). Measured — four of five probe shapes leaked. The prefix is
  // distinctive enough to need no anchor, and an anchor that fails open on
  // string concatenation is worse than none.
  { name: "credential", re: () => /apw-[a-z]{3}-[A-Za-z0-9_-]{16,}/g },
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
  // The COUNT of dropped keys, never their names. A key name is caller-controlled
  // and is itself free text — `{"victim.person@example.com": 1}` puts the PII in
  // the key rather than the value, and echoing names back would walk it straight
  // past both guards. The count keeps the signal that something was dropped
  // without reproducing any of it.
  if (dropped.length) out._droppedKeyCount = dropped.length;
  return { data: out, redactions: [...hits].sort(), dropped };
}

module.exports = {
  redactEventData,
  ALLOWED_KEYS,
  PATTERNS,
  PII_CHANGE_FIELDS,
};
