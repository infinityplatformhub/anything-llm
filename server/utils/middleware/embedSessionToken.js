// issue 32 — an embed session id must be PROVEN, not merely known.
//
// T-4b (#29) W-10 bound a session to the embed that issued it, closing the cross-tenant
// half of G12. It deliberately left the other half open: the session id is a client-chosen
// UUID (embed/src/hooks/useSessionId.js mints it with v4() into localStorage), so anyone
// who learns one — a shared machine, a screenshot, a log line, a support ticket — reads and
// deletes that visitor's whole conversation from any allowed origin.
//
// A token minted at session open closes it: the server signs
//   HMAC(SIG_KEY, embedUuid | sessionId | issuedAt)
// and the history routes verify that signature before doing anything else expensive.
//
// This is a bearer credential, not an identity: it proves "whoever opened this session is
// making this request", which is exactly the property the raw UUID lacked.

const crypto = require("crypto");

/** Header for embeds that cannot rely on cookies (third-party context, SameSite). */
const SESSION_TOKEN_HEADER = "x-allm-session-token";
/** Cookie for same-origin widgets. */
const SESSION_TOKEN_COOKIE = "allm_session_token";
/**
 * 24h. Long enough that a visitor reading their history the next morning is not logged out
 * of their own conversation, short enough that a leaked token stops working within a day.
 * The session row itself outlives the token; a new token is minted on the next open.
 */
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The signing key. SIG_KEY is created and persisted at boot by EncryptionManager, so it
 * exists on every deployment; this module never creates one, because a self-assigned key
 * here would silently invalidate every token the real key had already signed.
 */
function signingKey() {
  const key = process.env.SIG_KEY;
  if (!key) throw new Error("SIG_KEY is required to sign embed session tokens");
  return key;
}

/**
 * The signed payload. `embedUuid` is inside it so a token is not portable between embeds
 * even when the session id matches, and `issuedAt` is inside it so rewriting the timestamp
 * to extend a token's life invalidates the signature instead.
 */
const payloadOf = (embedUuid, sessionId, issuedAt) =>
  `${embedUuid}|${sessionId}|${issuedAt}`;

function sign(payload) {
  return crypto
    .createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
}

/**
 * Mint a token for a session. Called when a session is opened.
 * @param {{embedUuid: string, sessionId: string, issuedAt?: number}} input
 * @returns {string} `<issuedAt>.<signature>`
 */
function mintSessionToken({ embedUuid, sessionId, issuedAt = Date.now() }) {
  const stamp = String(issuedAt);
  return `${stamp}.${sign(payloadOf(embedUuid, sessionId, stamp))}`;
}

/**
 * Verify a token against the session it is presented for.
 *
 * Returns a reason rather than a boolean so the caller can answer 401 ("you have not
 * proven this session is yours") separately from 403 ("this token is for something else"),
 * without either answer revealing whether the session exists.
 *
 * @returns {{valid: true} | {valid: false, reason: "absent"|"malformed"|"expired"|"mismatch"}}
 */
function verifySessionToken({ token, embedUuid, sessionId, now = Date.now() }) {
  if (typeof token !== "string" || token.length === 0) {
    return { valid: false, reason: "absent" };
  }

  const parts = token.split(".");
  if (parts.length !== 2) return { valid: false, reason: "malformed" };
  const [stamp, signature] = parts;
  if (!/^\d+$/.test(stamp)) return { valid: false, reason: "malformed" };

  const expected = sign(payloadOf(embedUuid, sessionId, stamp));
  // Constant-time: a fast reject on the first differing byte would leak the signature a
  // byte at a time. Length is compared first because timingSafeEqual throws on a mismatch.
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return { valid: false, reason: "mismatch" };
  if (!crypto.timingSafeEqual(given, want)) return { valid: false, reason: "mismatch" };

  // Expiry is checked AFTER the signature: telling an unsigned caller "that is expired"
  // would confirm the timestamp they guessed was once real.
  if (now - Number(stamp) > SESSION_TOKEN_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true };
}

/**
 * Read the token off a request: header first, then cookie.
 *
 * PMO ruling: no cookie-parser dependency. The Cookie header is a well-defined
 * `name=value; name=value` string, and this reads exactly the one name it needs rather
 * than building a general parser.
 */
function tokenFromRequest(request) {
  const header =
    request?.headers?.[SESSION_TOKEN_HEADER] ??
    request?.header?.(SESSION_TOKEN_HEADER);
  if (typeof header === "string" && header.length > 0) return header;

  const cookieHeader = request?.headers?.cookie;
  if (typeof cookieHeader !== "string") return null;
  for (const pair of cookieHeader.split(";")) {
    const index = pair.indexOf("=");
    if (index === -1) continue;
    if (pair.slice(0, index).trim() !== SESSION_TOKEN_COOKIE) continue;
    const value = pair.slice(index + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

module.exports = {
  mintSessionToken,
  verifySessionToken,
  tokenFromRequest,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_COOKIE,
  SESSION_TOKEN_TTL_MS,
};
