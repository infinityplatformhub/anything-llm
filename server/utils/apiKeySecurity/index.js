const crypto = require("crypto");

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
};
