// S2 (#43), QA-1 NIT-1: turn an email into a local username, without merging
// two different people into one account.
//
// Shared by every identity driver on purpose. If OIDC and SAML each derived
// usernames their own way, the same person arriving over two protocols would
// become two accounts — or worse, two people would become one.
//
// The rule the schema enforces is `^[a-z][a-z0-9._@-]*$`, 2–64 characters. The
// previous implementation satisfied it by DELETING anything that did not fit at
// the front, which is where the bug lived: `alice@`, `1alice@` and `_alice@` all
// collapsed to `alice@`, so the second person to sign in hit the
// `users.username` unique constraint and got a flat 401 — against an account
// that had done nothing wrong. Nothing is dropped from the front now; a valid
// leading letter is added instead.

const crypto = require("crypto");

const MAX_LENGTH = 64;
const MIN_LENGTH = 2;
// Prefix for a local part that cannot start with a letter on its own. `u` is
// not meaningful; it just has to be a lowercase letter, and using one letter
// keeps the original text as intact as possible.
const LEADING_PREFIX = "u";

/**
 * Replace characters the schema does not allow, WITHOUT removing them.
 *
 * Substitution rather than deletion is the point: `álice` becomes `a-lice`, not
 * `lice`. Deleting would silently turn one person's address into another
 * person's plausible address.
 */
function sanitize(text) {
  return normalizeForCompare(text).replace(/[^a-z0-9._@-]/g, "-");
}

/**
 * The normalization both sides of a handle comparison must go through.
 *
 * NFC before lowercasing, because Unicode gives the same text two encodings:
 * `é` is one code point in NFC and `e` + a combining accent in NFD. Sanitizing
 * without normalizing first turns them into `-` and `e-` — two handles for one
 * name — so the same person arriving from an IdP that emits NFD would derive a
 * different username than the one they already own.
 */
function normalizeForCompare(text) {
  return String(text).normalize("NFC").toLowerCase();
}

/**
 * The username a given email derives to.
 *
 * Deterministic: the same address always gives the same handle, so a returning
 * user whose link row was somehow lost matches their existing account instead
 * of getting a second one.
 *
 * @param {string} email
 * @returns {string} a username satisfying ^[a-z][a-z0-9._@-]*$, 2-64 chars
 */
function deriveUsername(email) {
  let candidate = sanitize(email);

  // Add a leading letter rather than trimming to one. This is the whole fix:
  // the distinction between `1alice@` and `alice@` has to survive.
  if (!/^[a-z]/.test(candidate)) candidate = `${LEADING_PREFIX}${candidate}`;

  candidate = candidate.slice(0, MAX_LENGTH);

  // Truncation can strip a short local part down to nothing meaningful, and a
  // sanitized address could still be shorter than the minimum.
  if (candidate.length < MIN_LENGTH)
    candidate = `${candidate}${LEADING_PREFIX.repeat(MIN_LENGTH)}`.slice(0, MAX_LENGTH);

  return candidate;
}

/**
 * The username to try, then alternatives if it is taken.
 *
 * A collision here is NOT the R1 takeover case — that is checked against the
 * email before this runs. This covers two genuinely different addresses that
 * happen to derive the same handle: the second person gets a suffixed account
 * rather than a unique-constraint error that reads as "your login is broken".
 *
 * @param {string} email
 * @param {number} attempts total candidates to yield, including the plain one
 * @returns {Generator<string>}
 */
function* usernameCandidates(email, attempts = 5) {
  const base = deriveUsername(email);
  yield base;

  for (let i = 1; i < attempts; i++) {
    const suffix = `-sso-${crypto.randomBytes(4).toString("hex")}`;
    // Trim the BASE to make room, never the suffix: a truncated suffix could
    // collide with another truncated suffix, which is the problem it exists to
    // solve.
    const room = MAX_LENGTH - suffix.length;
    yield `${base.slice(0, room)}${suffix}`;
  }
}

module.exports = {
  deriveUsername,
  usernameCandidates,
  normalizeForCompare,
  MAX_LENGTH,
  MIN_LENGTH,
};
