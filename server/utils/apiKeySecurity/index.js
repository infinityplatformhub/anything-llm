const crypto = require("crypto");

const API_KEY_PREFIX = "apw-key-";
const BROWSER_KEY_PREFIX = "apw-brx-";
const DISPLAY_PREFIX_LENGTH = 16;
const MIN_PEPPER_BYTES = 32;

function pepper() {
  const value = process.env.API_KEY_PEPPER;
  if (!value || Buffer.byteLength(value) < MIN_PEPPER_BYTES)
    throw new Error("API_KEY_PEPPER must be at least 32 bytes");
  return value;
}

function assertApiKeyPepper() { pepper(); }

function makeSecret(prefix) {
  return `${prefix}${crypto.randomBytes(32).toString("base64url")}`;
}

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
  API_KEY_PREFIX,
  BROWSER_KEY_PREFIX,
  assertApiKeyPepper,
  makeSecret,
  digestSecret,
  keyPrefix,
  matchesDigest,
  parseScopes,
};
