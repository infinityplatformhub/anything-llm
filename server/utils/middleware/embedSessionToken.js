// issue 32 — an embed session id must be PROVEN, not merely known.
//
// T-4b (#29) W-10 bound a session to the embed that issued it, closing the cross-tenant
// half of G12. It deliberately left the other half open: the session id is a client-chosen
// UUID (embed/src/hooks/useSessionId.js mints it with v4() into localStorage), so anyone
// who learns one — a shared machine, a screenshot, a log line, a support ticket — reads and
// deletes that visitor's whole conversation from any allowed origin.
//
// A token minted at session open closes it: the server signs
//   HMAC(SIG_KEY, JSON([embedUuid, sessionId, issuedAt, firstIssuedAt]))
// and the history routes verify that signature before doing anything else expensive. The
// payload is a JSON array rather than pipe-joined text because the joined form was
// ambiguous — see payloadOf — and `firstIssuedAt` is in it so rotation cannot extend a
// session past its absolute ceiling.
//
// This is a bearer credential, not an identity: it proves "whoever opened this session is
// making this request", which is exactly the property the raw UUID lacked.
//
// issue 49: the session id is minted by the SERVER, at openSession. #32 let the client
// choose it and decided entitlement from whether an embed_chats row existed yet, which is
// what left holes 1-4 in residual-risks.md open — the rows arrive after the LLM replies and
// vanish when an embed is deleted, so "no rows" granted a token during the whole
// pre-first-reply window and again after any deletion. Now nobody chooses an id, so there
// is nothing to race for and nothing to derive. mintIfEntitled is rotation only.
//
// ENFORCEMENT on the history routes is separately behind EMBED_REQUIRE_SESSION_TOKEN,
// default off (PMO ruling on #32). The widget that stores the token and sends it back
// lives in the `embed/` submodule and ships separately, so the server must be able to run
// ahead of it without locking visitors out of their own history. See embedMiddleware.js.
// That flag governs only the demand; the minting rule below applies in both states, so a
// deployment mid-rollout is not handing out tokens that become valid when the flag flips.
//
// The flag is PRESENCE-based, so `=false` and `=` both enable it. That is deliberate and the
// asymmetry is the reason: under boolean parsing a typo silently DISABLES a gate the operator
// believes is on, while presence-based the worst case is an unexpected 401 — visible in
// minutes. Same convention as EMBED_REQUIRE_ALLOWLIST.
//
// DEPLOY NOTE (issue 49): the payload changed shape, so every token minted before it is
// invalid. There is deliberately no dual-verify path — accepting the old encoding would keep
// its collision alive for the length of the compatibility window. A deployment running with
// EMBED_REQUIRE_SESSION_TOKEN ON should flip it off before deploying and back on after.

const crypto = require("crypto");

/** Header for embeds that cannot rely on cookies (third-party context, SameSite). */
const SESSION_TOKEN_HEADER = "x-allm-session-token";
/** Cookie for same-origin widgets. */
const SESSION_TOKEN_COOKIE = "allm_session_token";
/**
 * 24h. Long enough that a visitor reading their history the next morning is not logged out
 * of their own conversation, short enough that a leaked token stops working within a day.
 *
 * "Within a day" holds only for a token nobody rotates — rotation issues a fresh 24h stamp,
 * so this alone is a sliding window rather than a deadline. SESSION_ABSOLUTE_MAX_MS below is
 * what bounds it absolutely. There is no session row: the token is self-contained.
 */
const SESSION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The ABSOLUTE ceiling on a session, counted from when it was first opened rather than from
 * the current token's stamp.
 *
 * TL-2 pre-read: rotation renews a token before it expires, so on its own the 24h TTL is a
 * rolling window, not a deadline — a stolen token that is refreshed every day never stops
 * working. `firstIssuedAt` travels through every rotation unchanged, which turns the
 * ceiling into a real one: after seven days the session ends no matter how diligently it
 * was renewed.
 *
 * The cost is that a visitor whose conversation genuinely spans more than a week starts a
 * new session. That is a visible, recoverable inconvenience; an unbounded stolen credential
 * is neither.
 */
const SESSION_ABSOLUTE_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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
 * How far ahead of this clock a token may claim to have been issued.
 *
 * Not zero: servers behind a load balancer disagree by seconds, and refusing every future
 * stamp would log a visitor out whenever they happened to be served by the machine whose
 * clock runs fast — an intermittent outage nobody could reproduce.
 */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * The signed payload. `embedUuid` is inside it so a token is not portable between embeds
 * even when the session id matches, and `issuedAt` is inside it so rewriting the timestamp
 * to extend a token's life invalidates the signature instead.
 *
 * issue 49 F1: JSON.stringify of an ARRAY rather than `a|b|c`. The old form was ambiguous —
 * the separator is a character the fields may themselves contain, so different field values
 * produced the same string to sign:
 *
 *     sign("A|B", "C", 1) === sign("A", "B|C", 1)     (measured, not argued)
 *
 * That did not leak, because both fields are server-generated UUIDs and a UUID has no pipe
 * in it. But that is a property of today's CALLERS, not of the signing scheme, and #49 is
 * the change that adds a second server-chosen field here and invites a third. The first
 * user-controlled field in this payload would turn a formatting detail into token forgery.
 * JSON escapes its own delimiters, so no field value can imitate the structure around it.
 */
const payloadOf = (embedUuid, sessionId, issuedAt, firstIssuedAt) =>
  JSON.stringify([
    String(embedUuid),
    String(sessionId),
    String(issuedAt),
    String(firstIssuedAt),
  ]);

function sign(payload) {
  return crypto
    .createHmac("sha256", signingKey())
    .update(payload)
    .digest("base64url");
}

/**
 * Mint a token for a session.
 *
 * `firstIssuedAt` defaults to `issuedAt`, which is what a session OPEN means: this is the
 * first token, so the two are the same moment. A rotation passes the original through
 * unchanged, which is what makes SESSION_ABSOLUTE_MAX_MS a ceiling rather than a rolling
 * window — see mintIfEntitled.
 *
 * Both stamps are inside the signed payload, so neither can be rewritten to buy time.
 *
 * @param {{embedUuid: string, sessionId: string, issuedAt?: number, firstIssuedAt?: number}} input
 * @returns {string} `<issuedAt>.<firstIssuedAt>.<signature>`
 */
function mintSessionToken({
  embedUuid,
  sessionId,
  issuedAt = Date.now(),
  firstIssuedAt = issuedAt,
}) {
  const stamp = String(issuedAt);
  const origin = String(firstIssuedAt);
  return `${stamp}.${origin}.${sign(payloadOf(embedUuid, sessionId, stamp, origin))}`;
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
  if (parts.length !== 3) return { valid: false, reason: "malformed" };
  const [stamp, origin, signature] = parts;
  if (!/^\d+$/.test(stamp) || !/^\d+$/.test(origin)) {
    return { valid: false, reason: "malformed" };
  }

  const expected = sign(payloadOf(embedUuid, sessionId, stamp, origin));
  // Constant-time: a fast reject on the first differing byte would leak the signature a
  // byte at a time. Length is compared first because timingSafeEqual throws on a mismatch.
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length) return { valid: false, reason: "mismatch" };
  if (!crypto.timingSafeEqual(given, want)) return { valid: false, reason: "mismatch" };

  // Expiry is checked AFTER the signature: telling an unsigned caller "that is expired"
  // would confirm the timestamp they guessed was once real.
  //
  // issue 49 F2: bounded in BOTH directions. `now - stamp > TTL` alone means a stamp in the
  // future is not old and therefore never expires — a token minted a year ahead verified
  // clean and stayed valid for a year. Nothing in-tree mints one, but `issuedAt` is a
  // parameter and a clock that jumps forward once produces tokens that outlive the TTL the
  // whole scheme is bounded by. Reported as "malformed" rather than "expired" because that
  // is what it is: a stamp this server could not have issued.
  const issuedAt = Number(stamp);
  // TL-2: `/^\d+$/` above rejects "1e999", but NOT "9" repeated four hundred times — that is
  // digits-only and becomes Infinity, and an infinite issuedAt is never more than a TTL in
  // the past, so on its own the TTL check would treat the token as immortal.
  //
  // Honest note on this line: it is REDUNDANT today. Mutation testing removed it and the
  // suite stayed green, because the skew bound below already refuses Infinity
  // (Infinity > now + skew) and every other value the digits-only pattern admits is finite
  // and positive. It is kept as defence in depth for a specific foreseeable edit — moving,
  // loosening, or removing the skew bound would silently restore the immortal-token bug —
  // and it is documented as redundant rather than covered by a contrived test, because a
  // test written to fail for this line alone would be asserting an implementation detail
  // rather than a behaviour anyone can observe.
  const firstIssuedAt = Number(origin);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(firstIssuedAt)) {
    return { valid: false, reason: "malformed" };
  }
  if (issuedAt > now + CLOCK_SKEW_MS) return { valid: false, reason: "malformed" };
  if (firstIssuedAt > now + CLOCK_SKEW_MS) {
    return { valid: false, reason: "malformed" };
  }
  if (now - issuedAt > SESSION_TOKEN_TTL_MS) {
    return { valid: false, reason: "expired" };
  }
  // The ABSOLUTE ceiling. Checked separately from the TTL above and reported the same way:
  // both mean "this credential has run out", and telling them apart would say how long ago
  // the session was opened, which is not the caller's business when they cannot prove it is
  // theirs. Without this, rotation renews forever and the TTL is a rolling window.
  if (now - firstIssuedAt > SESSION_ABSOLUTE_MAX_MS) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true };
}

/**
 * Open a NEW session: the server picks the id, and mints its token in the same breath.
 *
 * issue 49. This exists because `mintIfEntitled` below could not be made correct. It decides
 * entitlement by asking whether an `embed_chats` row exists for (embed, session) — and every
 * residual hole #32 left is a consequence of that question rather than of the answer:
 *
 *   - The row is written only after the LLM has replied (`EmbedChats.new`), so between a
 *     visitor's first request and their first stored reply, an attacker naming the same id
 *     is equally "new" and is handed a valid token.
 *   - Two concurrent first requests both read "no row" and both mint.
 *   - `embed_chats.embed_id` is `onDelete: Cascade`, so deleting and recreating an embed
 *     empties the rows and makes every id in it mintable again.
 *   - Whether a token comes back in the response is itself an answer to "does this session
 *     exist".
 *
 * No tightening of the RULE closes those, because any rule of the form "mint for free in
 * some case" leaves that case open, and #32's is already the narrowest one that still lets a
 * genuine first message through. What closes them is removing the question: if the SERVER
 * chooses the id, there is nothing to race for, nothing for a caller to name, and nothing
 * derived from rows.
 *
 * The caller supplies no id. Anything it sends is ignored rather than validated — an
 * endpoint that accepts a caller's id is a client-chosen id wearing a server-minted name,
 * and all four holes come back with it.
 *
 * @param {{embed: {uuid: string}}} input
 * @returns {{sessionId: string, token: string}}
 */
function openSession({ embed }) {
  const embedUuid = String(embed.uuid);
  const sessionId = crypto.randomUUID();
  return { sessionId, token: mintSessionToken({ embedUuid, sessionId }) };
}

/**
 * Rotate the token of a session the caller has ALREADY proven is theirs.
 *
 * History, because the name changed twice for two different reasons:
 *
 *   - It began as unconditional minting: stream-chat issued a token for whatever sessionId
 *     the body named. That made the whole scheme a formality (#32 QA-1 BLOCKER-1) — an
 *     attacker who learned a victim's UUID asked for a token against it and read their
 *     history. The token proved possession of a UUID, which is what the bare UUID proved.
 *   - #32 narrowed it to two entitlements: the session is NEW (no embed_chats row), or the
 *     caller already holds a valid token (rotation). issue 49 removes the FIRST of those.
 *
 * "New" was never a property of the session; it was a property of the ROWS, and the rows
 * arrive late (`EmbedChats.new` writes only after the LLM has replied) and can go away
 * (`embed_id` is `onDelete: Cascade`). So "no rows" meant "mintable" during the whole
 * pre-first-reply window and again after any deletion — holes 1 and 3. A session that is
 * genuinely new now gets its id and its token together from `openSession`, where being new
 * is guaranteed by construction rather than inferred from storage.
 *
 * What remains is rotation, and only rotation: a caller who presents a VALID token for this
 * session gets a fresh one. That is not a hole — it demands the proof the whole scheme is
 * built on — and without it an ongoing conversation would be logged out at the 24h TTL.
 *
 * A caller with no proof gets null, and the chat still proceeds rather than 4xx-ing:
 * refusing would answer "does this session exist" just as usefully as a token would.
 *
 * No longer reads embed_chats at all. That is the point rather than an optimisation —
 * entitlement that consults rows is entitlement that returns when the rows change.
 *
 * @returns {Promise<string|null>} the token, or null when the caller has not proven the session
 */
async function mintIfEntitled({ embed, sessionId, request }) {
  const embedUuid = String(embed.uuid);
  const token = tokenFromRequest(request);
  const verdict = verifySessionToken({
    token,
    embedUuid,
    sessionId: String(sessionId),
  });
  if (!verdict.valid) return null;

  // The new token carries the ORIGINAL firstIssuedAt, not a fresh one. Restarting it here
  // would make SESSION_ABSOLUTE_MAX_MS unreachable — every rotation would push the ceiling
  // out by another seven days, which is the rolling window the ceiling exists to end.
  //
  // Read from the presented token rather than passed in, because the token is the only place
  // it lives (there is no session row), and it is safe to read only because the signature
  // was just verified: `verdict.valid` means these bytes are ours.
  return mintSessionToken({
    embedUuid,
    sessionId: String(sessionId),
    firstIssuedAt: firstIssuedAtOf(token),
  });
}

/**
 * The `firstIssuedAt` inside a token. ONLY safe on a token whose signature has just been
 * verified — this parses, it does not authenticate.
 */
function firstIssuedAtOf(token) {
  return Number(String(token).split(".")[1]);
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
  openSession,
  verifySessionToken,
  tokenFromRequest,
  SESSION_TOKEN_HEADER,
  SESSION_TOKEN_COOKIE,
  SESSION_TOKEN_TTL_MS,
  SESSION_ABSOLUTE_MAX_MS,
  CLOCK_SKEW_MS,
};
