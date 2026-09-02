const crypto = require("crypto");

// issue 71: COUPLED to the `credential` pattern in utils/events/redaction.js,
// which redacts `apw-xxx-` followed by 16 or more characters. A prefix is
// `apw-key-` (8) plus this many minus 8 — at 16 that is 8 trailing characters,
// one short of matching. Raise this to 24 and every keyPrefix in an audit row
// starts being redacted as a credential, silently costing the audit log its join
// key. Asserted in __tests__/utils/events/auditRedaction.test.js.
const DISPLAY_PREFIX_LENGTH = 16;
const MIN_PEPPER_BYTES = 32;

function pepper() {
  const value = process.env.API_KEY_PEPPER;
  if (!value || ["undefined", "null"].includes(value.trim().toLowerCase()) || Buffer.byteLength(value.trim()) < MIN_PEPPER_BYTES)
    throw new Error("API_KEY_PEPPER must be at least 32 bytes");
  return value;
}

function assertApiKeyPepper() { pepper(); }

function digestSecret(secret) {
  return crypto.createHmac("sha256", pepper()).update(secret).digest();
}

function keyPrefix(secret) {
  return secret.slice(0, DISPLAY_PREFIX_LENGTH);
}

function matchesDigest(secret, storedDigest) {
  const candidate = digestSecret(secret);
  const stored = Buffer.isBuffer(storedDigest) ? storedDigest : Buffer.from(storedDigest);
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function parseScopes(scopes) {
  try {
    const parsed = JSON.parse(scopes || "[]");
    return Array.isArray(parsed) ? parsed.filter((scope) => typeof scope === "string") : [];
  } catch {
    return [];
  }
}

assertApiKeyPepper();

module.exports = {
  assertApiKeyPepper,
  digestSecret,
  keyPrefix,
  matchesDigest,
  parseScopes,
  // Exported so the coupling with the redaction pattern can be ASSERTED rather
  // than described in a comment nobody runs. See the note on its declaration.
  DISPLAY_PREFIX_LENGTH,
};
