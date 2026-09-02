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
//
// Minting is CONDITIONAL — see mintIfEntitled. An earlier revision minted for whatever
// session id a request named, which made the gate a formality: an attacker holding a
// victim's UUID could mint their way past it (QA-1 BLOCKER-1).
//
// ENFORCEMENT on the history routes is separately behind EMBED_REQUIRE_SESSION_TOKEN,
// default off (PMO ruling on #32). The widget that stores the token and sends it back
// lives in the `embed/` submodule and ships separately, so the server must be able to run
// ahead of it without locking visitors out of their own history. See embedMiddleware.js.
// That flag governs only the demand; the minting rule below applies in both states, so a
// deployment mid-rollout is not handing out tokens that become valid when the flag flips.

const crypto = require("crypto");
const prisma = require("../prisma");

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
 * Decide whether this request may be issued a token for `sessionId`, and mint it if so.
 *
 * QA-1 BLOCKER-1: minting used to be unconditional, which made the whole scheme a
 * formality. stream-chat minted for whatever sessionId the body named, so an attacker who
 * had learned a victim's UUID — the exact threat this issue exists to close — could ask for
 * a token against it and then read the history with it. The token proved possession of a
 * UUID, which is what the bare UUID already proved.
 *
 * Two ways to be entitled, and only two:
 *
 *   1. The session is NEW — no embed_chats row for this embed and session. Nobody's
 *      conversation is behind it yet, so there is nothing to steal. This is how a genuine
 *      first message gets its token.
 *   2. The caller already holds a valid token for it — rotation. Every message after the
 *      first names a session that now has rows, so without this an ongoing conversation
 *      would stop being able to refresh.
 *
 * Naming an existing session with no proof gets null: no token, and the chat itself still
 * proceeds, because refusing to answer would turn this into a "does this session exist"
 * oracle of a different shape.
 *
 * Scoped to (embed_id, session_id) rather than session_id alone: a session id that belongs
 * to a different embed is not "existing" here, and must not block minting for this one.
 *
 * @returns {Promise<string|null>} the token, or null when the caller has not earned one
 */
async function mintIfEntitled({ embed, sessionId, request, db = prisma }) {
  const embedUuid = String(embed.uuid);

  const existing = await db.embed_chats.findFirst({
    where: { embed_id: embed.id, session_id: String(sessionId) },
    select: { id: true },
  });
  if (!existing) return mintSessionToken({ embedUuid, sessionId: String(sessionId) });

  const verdict = verifySessionToken({
    token: tokenFromRequest(request),
    embedUuid,
    sessionId: String(sessionId),
  });
  return verdict.valid ? mintSessionToken({ embedUuid, sessionId: String(sessionId) }) : null;
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
  mintIfEntitled,
  verifySessionToken,
  tokenFromRequest,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_COOKIE,
  SESSION_TOKEN_TTL_MS,
};
