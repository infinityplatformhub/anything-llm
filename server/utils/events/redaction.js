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
//
// #99: `\d` does not match FULLWIDTH digits (`１２３`), so a national ID typed on
// a Japanese or Chinese IME reached the audit log intact. The classes below
// match `[0-9０-９]` directly rather than normalising the string first.
//
// NFKC normalisation is the obvious fix and is NOT used: it CHANGES STRING
// LENGTH. Measured — `ﬁ` → `fi` (1→2), `㍿` → `株式会社` (1→4). So "normalise,
// scrub, map the offsets back" is unsound, because the offsets do not
// correspond and a mapping that drifts silently redacts the wrong span of
// someone's text. Storing the normalised form instead would change stored
// values beyond redaction, on a path whose contract is "redact PII, otherwise
// store what happened".
//
// Other Unicode digit families (Arabic-Indic, Devanagari) remain unmatched.
// Adding them is a one-line change here when someone needs it; guessing at
// which ones matter today would be inventing scope.
//
// RESIDUAL, measured and deliberately left: the DIGITS are handled, the
// SEPARATORS are not. `credit_card`'s `[ -]?` is ASCII-only, so a card written
// with fullwidth punctuation is not redacted even though every digit in it now
// matches:
//
//   １２３４ ５６７８ ９０１２ ３４５６   (ASCII space)      → redacted
//   １２３４　５６７８　９０１２　３４５６   (U+3000)          → NOT redacted
//   1234－5678－9012－3456              (U+FF0D)          → NOT redacted
//
// Closing it means widening the separator class, which is a different change
// from widening the digit class and deserves its own fixture — a number where
// the separator is the only variable. Raised as its own issue rather than
// folded in here.
const D = "[0-9０-９]";
const NOT_D = "(?<![0-9０-９])";
const NOT_D_AFTER = "(?![0-9０-９])";

/**
 * #120: what may sit BETWEEN the digit groups of a card number.
 *
 * #118 widened the digits to fullwidth and left the punctuation ASCII, so
 * `１２３４ ５６７８ …` redacted and `1234－5678－9012－3456` did not — measured
 * on `c44b059d3`, only U+0020, U+002D and no separator at all matched, in
 * either digit width, and a number mixing separators missed entirely. A card
 * typed on a CJK IME normally carries U+3000 or U+FF0D, so the miss was the
 * ordinary case on exactly the input #118 was widening for.
 *
 * IN: the visible separators a person or an IME actually produces between digit
 * groups — the spaces and the dash family.
 *
 * OUT, and each is a decision rather than an omission:
 *
 *   \n and \t — `1234\n5678\n9012\n3456` down four log lines is not one card
 *   number. A class matching any Unicode whitespace would let an ordinary
 *   four-column numeric log redact itself, destroying the log without
 *   protecting anyone.
 *
 *   U+200B, U+FEFF, U+00AD (zero-width) — an evasion vector rather than a
 *   typing artifact, and sixteen contiguous digits already match, so the loss
 *   is narrow. Where invisible characters should be stripped is its own
 *   question and belongs in its own issue, not in a separator class.
 *
 *   `,` and `，` — proposed as IN and REVERSED after measurement. A comma
 *   between numbers is how lists are written, so the class caught
 *   `ids: 1001,1002,1003,1004`, `1000,2000,3000,4000`, chunk sizes and order
 *   ids, none of which the old pattern ever touched. That is the newline
 *   argument again: an ordinary log redacting itself protects nobody. Both
 *   widths go out together, so the symmetry that motivated adding the ASCII one
 *   is kept — a card written with commas is not a form anyone types.
 *
 *   `.` `/` `:` `．` `：` `＝` `＿` — these join fields, versions, dates and
 *   paths far more often than they join card groups.
 *
 * `phone_th` and `thai_national_id` are untouched: they have no separator
 * today, and giving them one has its own false-positive profile.
 */
const SEPARATORS = [
  "\\u0020", // space
  "\\u002D", // hyphen-minus
  "\\u00A0", // no-break space
  "\\u2009", // thin space
  "\\u202F", // narrow no-break space
  "\\u2010", // hyphen
  "\\u2011", // non-breaking hyphen
  "\\u2012", // figure dash
  "\\u2013", // en dash
  "\\u2014", // em dash
  "\\u2015", // horizontal bar
  "\\u2212", // minus sign
  "\\u3000", // ideographic space
  "\\uFF0D", // fullwidth hyphen-minus
];
// Each entry is an ESCAPE SEQUENCE, not the character itself, and the class is
// built from those escapes. Writing the literal characters would put
// `[ -\u3000]` into the pattern — a RANGE from space to the ideographic space,
// which matches `.`, `/`, `:` and every ASCII letter, so `1234.5678.9012.3456`
// would redact as a card. Found while mutating this class: a mutant written with
// literals turned the negative controls red, which is the class silently
// becoming "any character".
const SEP = `[${SEPARATORS.join("")}]?`;

const PATTERNS = [
  { name: "thai_national_id", re: () => new RegExp(`${NOT_D}${D}{13}${NOT_D_AFTER}`, "g") },
  {
    name: "credit_card",
    re: () =>
      new RegExp(
        `${NOT_D}${D}{4}${SEP}${D}{4}${SEP}${D}{4}${SEP}${D}{1,4}${NOT_D_AFTER}`,
        "g"
      ),
  },
  { name: "email", re: () => /[\w.+-]+@[\w-]+\.[\w.]+/g },
  // The leading zero is a CLASS too, not a literal `0`: a fullwidth phone
  // number starts with `０`, and a pattern that matched fullwidth digits
  // everywhere except the anchor character would miss the whole number.
  {
    name: "phone_th",
    re: () => new RegExp(`${NOT_D}[0０]${D}{8,9}${NOT_D_AFTER}`, "g"),
  },
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
  // #101. `thai_national_id` demands exactly 13 and `credit_card` tops out at
  // 16, so a run of 17 or more digits matched NOTHING and was stored verbatim.
  // That is reachable by construction: anyone who knows these patterns can pad
  // an identifier past 16 digits.
  //
  // Deliberately makes NO semantic claim. The marker says a long run of digits
  // was here, not what it was, because not knowing is the whole situation.
  //
  // Placed last for readability. THIS pattern's position is not load-bearing:
  // measured, it and the classified ones are disjoint, because the digit
  // lookarounds mean `credit_card` cannot match inside a run of 17+ (a digit
  // follows its last group) and this cannot match 16 or fewer. Moving it to
  // the front changes no outcome — verified by mutation, which is how an
  // earlier version of this comment was found to be wrong.
  //
  // ORDER ELSEWHERE IN THIS LIST IS LOAD-BEARING, and the qualifier matters:
  // `credit_card` DOES match a 13-digit run (`1234567890123` satisfies
  // 4+4+4+1 with the separators absent — measured). `thai_national_id` runs
  // first and claims it, which is the only reason a national id is labelled as
  // one rather than as a card. Swapping those two mislabels every Thai id.
  //
  // What this pattern's disjointness DEPENDS ON is those lookarounds. Relax
  // them and it starts eating the tail of every card number, which is why the
  // tests pin the specific labels rather than only the fact of redaction.
  {
    name: "long_digit_run",
    re: () => new RegExp(`${NOT_D}${D}{17,}${NOT_D_AFTER}`, "g"),
  },
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
/**
 * #131: characters that are invisible in a value and defeat every pattern above.
 *
 * Measured on `da2cb0cd8`: one of these anywhere inside a value made it invisible
 * to EVERY pattern here — national id, phone, card, credential, email,
 * long_digit_run — and the row then recorded `redactions: []`. That is positive
 * evidence of cleanliness that is false, where a mangled value would at least
 * look wrong. It is not a per-pattern bug: it is a property of every pattern that
 * matches adjacent characters.
 *
 * THE CLASS IS A UNION OF TWO PROPERTIES, and both halves were measured to be
 * necessary — no hand-list, because #71 already shipped the lesson that an
 * enumeration misses its next member (`apw-tat-` escaped a three-prefix
 * alternation):
 *
 *   `\p{Cf}` alone misses U+034F COMBINING GRAPHEME JOINER and U+17B4/U+17B5
 *   (Khmer inherent vowels). All three are `Mn`, all three defeat every pattern.
 *
 *   `\p{Default_Ignorable_Code_Point}` alone misses 32 `Cf` codepoints that
 *   defeat the patterns too — U+0600-U+0605, U+06DD, U+070F, U+0890, U+0891,
 *   U+08E2, U+FFF9-U+FFFB, U+110BD, U+110CD and the Egyptian-hieroglyph format
 *   controls U+13430-U+1343F.
 *
 * Deliberately NOT `\p{Mn}` at large: 1818 `Mn` codepoints defeat a pattern, but
 * they include every Thai and Vietnamese diacritic. Stripping those would mangle
 * ordinary text — measured, `สวัสดีครับ` becomes `สวสดครบ`. Default_Ignorable is
 * exactly the property that says "this is not meant to be seen", which is the
 * class actually at issue; verified that Thai and NFD Vietnamese pass through the
 * union untouched.
 *
 * NOT NFKC, and now for two reasons. The first is the one this file already gives
 * one screen up: normalisation changes LENGTH (`ﬁ`→`fi`, `㍿`→`株式会社`), so
 * scrub-then-map-offsets-back is unsound. The second is that NFKC folds `１２３４`
 * to `1234` and `－` to `-`, which would make the fullwidth digit class (#118) and
 * the separator class (#120) dead code. Stripping is different in kind — every
 * codepoint in this union is length-reducing by exactly one and nothing is
 * substituted.
 */
// NOT `/g`. Every use here is `.test`, and `.test` on a global regex advances
// `lastIndex` between calls — the loop below tests one codepoint at a time, so
// a global flag would make it walk the string instead of examining the
// character it was handed.
//
// NO TEST PINS THIS, and that is measured rather than assumed: flipping the
// flag to `/g` leaves all 355 green. Every string that reaches the loop is
// tested against single characters, where `lastIndex` resets to 0 on each
// failure and the alternating answers happen to land the same way. It is a
// latent trap for the next caller, not a live defect — so it is written
// correctly and labelled, instead of being claimed as covered.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;

/**
 * Replace every pattern hit in a string with its class marker.
 *
 * When the value carries invisible characters the scan runs on a STRIPPED copy,
 * so a disguised value is still found — but only the spans the patterns actually
 * claimed are rewritten. Every invisible character outside a match stays exactly
 * where it was.
 *
 * That per-match rule is the whole design, and the case that forces it is not
 * Thai. U+FE0F VARIATION SELECTOR-16 is Default_Ignorable, so a whole-string
 * strip turns `❤️` into `❤` and `1️⃣` into `1` — a field is silently re-rendered
 * because something ELSE in it was PII. `TextSplitter` word marks (U+200B at ICU
 * boundaries) are the same failure with a less visible symptom.
 *
 * Keeping the stripped text INSIDE a match is deliberate: there, the invisible
 * character was the disguise, and preserving it next to `[redacted:…]` keeps the
 * evasion attempt in the log for no benefit.
 *
 * The offset map is an ARRAY, never arithmetic. `origin[i]` records which index
 * of the original produced `stripped[i]`; strip is deletion only, so each
 * surviving unit knows its own source. Sliding by a running count instead is
 * wrong by one per codepoint removed before that point — TL-2 measured it
 * cutting a character short.
 *
 * Everything here is indexed in CODE UNITS, because that is what `RegExp.exec`
 * and `String.slice` use. `U+13430` is a `Cf` codepoint above U+FFFF and
 * therefore two units: a map built by iterating codepoints while slicing by
 * units slides by one per astral character and cuts into the middle of a
 * surrogate pair, which yields a lone surrogate rather than an error and so
 * corrupts silently.
 */
function scrubString(value, hits) {
  const scan = (text) => {
    let out = text;
    let matched = false;
    for (const { name, re } of PATTERNS) {
      out = out.replace(re(), () => {
        hits.add(name);
        matched = true;
        return `[redacted:${name}]`;
      });
    }
    return { out, matched };
  };

  if (!INVISIBLE.test(value)) return scan(value).out;

  // Strip to FIND, keeping a map back to the original. Iterating by code POINT
  // is what makes an astral character a single decision; pushing one entry per
  // code UNIT is what keeps the map usable with `exec` and `slice`.
  let stripped = "";
  const origin = [];
  for (let index = 0; index < value.length; ) {
    const point = String.fromCodePoint(value.codePointAt(index));
    if (!INVISIBLE.test(point)) {
      stripped += point;
      for (let unit = 0; unit < point.length; unit += 1) origin.push(index + unit);
    }
    index += point.length;
  }

  // Collect the spans each pattern claims, on the stripped text.
  const spans = [];
  for (const { name, re } of PATTERNS) {
    const pattern = re();
    let match;
    while ((match = pattern.exec(stripped)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      spans.push({ start: match.index, end: match.index + match[0].length, name });
    }
  }
  if (spans.length === 0) {
    // Nothing matched even undisguised: the value is ordinary text and is
    // returned byte-identical, invisible characters and all.
    return value;
  }

  // Earliest first; on a tie the longer span wins, and an overlap is resolved in
  // favour of whichever pattern comes first in PATTERNS — the same precedence
  // the sequential replace already had, which is why `1234567890123` stays a
  // `thai_national_id` rather than becoming a `credit_card`.
  spans.sort((left, right) =>
    left.start - right.start ||
    right.end - left.end ||
    PATTERNS.findIndex((p) => p.name === left.name) -
      PATTERNS.findIndex((p) => p.name === right.name)
  );

  let out = "";
  let cursor = 0;
  let consumed = -1;
  for (const span of spans) {
    if (span.start < consumed) continue;
    const from = origin[span.start];
    const to = origin[span.end - 1] + 1;
    out += value.slice(cursor, from) + `[redacted:${span.name}]`;
    hits.add(span.name);
    cursor = to;
    consumed = span.end;
  }
  return out + value.slice(cursor);
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
  // O5b (#94): the diagnostic bundle needs the PATTERN SCAN without the
  // top-level allowlist. `redactEventData` would drop every one of the bundle's
  // own section names, which are not audit-event data keys. The bundle applies
  // its own allowlist to the environment (utils/diagnostics ENV_ALLOWLIST) and
  // uses this for the free text that survives it.
  scrubValue,
  ALLOWED_KEYS,
  PATTERNS,
  PII_CHANGE_FIELDS,
};
