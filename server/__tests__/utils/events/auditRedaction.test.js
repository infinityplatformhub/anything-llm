// T-6 Phase A (#28): the sentinel test. Fires a payload carrying every PDPA class
// and a non-allowlisted secret directly at AuditEventSubscriber.handle(), then
// reads the stored row back. Asserts on what LANDED IN THE DATABASE, not on what
// the redaction function returned — the guard has to be at the sink, and a unit
// test of redaction alone would pass with the subscriber unwired.
//
// Real Postgres per code-standards section 7.1: the row is written through Prisma
// and read back through Prisma.

const crypto = require("crypto");
const path = require("path");
const { execFileSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { PG_SCHEME } = require("../../../utils/test/postgresUrl");

const SERVER_DIR = path.resolve(__dirname, "../../..");
const SCHEMA = path.join(SERVER_DIR, "prisma/schema.prisma");
const PRISMA_BIN = path.join(SERVER_DIR, "node_modules/.bin/prisma");
const suffix = crypto.randomBytes(4).toString("hex");
const testSchemaName = `t6_redaction_${suffix}`;

const baseDatabaseUrl = process.env.DATABASE_URL;
if (!baseDatabaseUrl?.startsWith(PG_SCHEME))
  throw new Error("DATABASE_URL must point at PostgreSQL for this suite");
const testUrl = new URL(baseDatabaseUrl);
testUrl.searchParams.set("schema", testSchemaName);

let prisma;
let subscriber;

const SENTINEL = {
  email: "somchai.pdpa@example.co.th",
  thaiId: "1234567890123",
  phone: "0812345678",
  card: "4111111111111111",
};

function auditEvent(data, overrides = {}) {
  return {
    eventId: crypto.randomUUID(),
    type: "user_updated",
    version: 1,
    occurredAt: new Date(),
    actor: { type: "user", id: "4242", orgId: "default" },
    resource: { type: "system", id: null },
    data,
    ...overrides,
  };
}

async function storedFor(event) {
  await subscriber.handle(event);
  return prisma.event_logs.findUnique({ where: { eventId: event.eventId } });
}

beforeAll(async () => {
  execFileSync(PRISMA_BIN, ["migrate", "deploy", "--schema", SCHEMA], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: testUrl.toString() },
    stdio: "pipe",
  });
  prisma = new PrismaClient({
    datasources: { db: { url: testUrl.toString() } },
  });
  const {
    AuditEventSubscriber,
  } = require("../../../utils/events/AuditEventSubscriber");
  subscriber = new AuditEventSubscriber({ db: prisma });
});

afterAll(async () => {
  await prisma?.$disconnect();
  const admin = new PrismaClient({
    datasources: { db: { url: baseDatabaseUrl } },
  });
  await admin.$executeRawUnsafe(
    `DROP SCHEMA IF EXISTS "${testSchemaName}" CASCADE`
  );
  await admin.$disconnect();
});

describe("audit sink redacts PDPA data before the row exists", () => {
  test("no raw PDPA value from a sentinel payload reaches event_logs", async () => {
    const row = await storedFor(
      auditEvent({
        username: SENTINEL.email,
        prevSystemPrompt: `contact ${SENTINEL.phone} or ${SENTINEL.email}`,
        newSystemPrompt: `id ${SENTINEL.thaiId} card ${SENTINEL.card}`,
      })
    );

    for (const raw of Object.values(SENTINEL))
      expect(row.metadata).not.toContain(raw);
    expect(row.metadata).toContain("[redacted:email]");
    expect(row.metadata).toContain("[redacted:phone_th]");
    expect(row.metadata).toContain("[redacted:thai_national_id]");
    expect(row.metadata).toContain("[redacted:credit_card]");
  });

  test("a key outside the allowlist is dropped rather than stored", async () => {
    const row = await storedFor(
      auditEvent({
        username: "plain-user",
        password: "hunter2-plaintext",
        apiSecret: "sk-live-should-never-land",
      })
    );

    expect(row.metadata).not.toContain("hunter2-plaintext");
    expect(row.metadata).not.toContain("sk-live-should-never-land");
    expect(JSON.parse(row.metadata).username).toBe("plain-user");
  });

  test("changes never stores a prev to next pair for a PII field", async () => {
    const row = await storedFor(
      auditEvent({
        username: "editor",
        changes: {
          password: "old-secret => new-secret",
          email: `old@example.com => ${SENTINEL.email}`,
          bio: "old bio => new bio",
        },
      })
    );

    const changes = JSON.parse(row.metadata).changes;
    expect(changes.password).toBe("[redacted:changed]");
    expect(changes.email).toBe("[redacted:changed]");
    expect(row.metadata).not.toContain("old-secret");
    expect(row.metadata).not.toContain("new-secret");
    expect(row.metadata).not.toContain("old@example.com");
    expect(changes.bio).toBe("old bio => new bio");
  });

  test("join keys survive redaction untouched", async () => {
    const event = auditEvent({ username: SENTINEL.email });
    const row = await storedFor(event);

    expect(row.eventId).toBe(event.eventId);
    expect(row.event).toBe("user_updated");
    expect(row.userId).toBe(4242);
    expect(row.occurredAt.toISOString()).toBe(event.occurredAt.toISOString());
  });

  test("a dropped key name is not echoed back into the row", async () => {
    // A key name is caller-controlled free text, so a payload can carry its PII in
    // the key rather than the value. Recording the names of dropped keys would
    // walk it straight past both guards.
    const row = await storedFor(
      auditEvent({
        username: "plain-user",
        [SENTINEL.email]: "value-under-a-pii-key",
        some_unknown_field: "UNKNOWN-SENTINEL-VALUE",
      })
    );

    expect(row.metadata).not.toContain(SENTINEL.email);
    expect(row.metadata).not.toContain("UNKNOWN-SENTINEL-VALUE");
    expect(JSON.parse(row.metadata)._droppedKeyCount).toBe(2);
  });

  test("nested string values are scanned at depth", async () => {
    const row = await storedFor(
      auditEvent({
        embeddedFiles: [{ note: `sent to ${SENTINEL.email}` }],
      })
    );

    expect(row.metadata).not.toContain(SENTINEL.email);
    expect(row.metadata).toContain("[redacted:email]");
  });
});

// issue 71: an invite code is a BEARER CREDENTIAL, not metadata.
//
// RED-first: written before the fix. `inviteCode` was on the allowlist and no
// PDPA pattern matches `apw-inv-<base64url>`, so the code reached event_logs
// byte for byte.
//
// Why that is worse than it sounds: `POST /invite/:code` is public and creates
// an account with workspace access, invites have no expiry, and the audit log is
// built to be exported to a SIEM. The credential therefore outlives, and travels
// further than, the system that issued it.
describe("issue 71: invite codes never reach the audit log", () => {
  const { Invite } = require("../../../models/invite");
  const { ALLOWED_KEYS } = require("../../../utils/events/redaction");

  test("a real generated invite code does not survive redaction", async () => {
    // Generated by the real function, not a hand-written lookalike: a fixture
    // that merely resembles the format proves nothing once the format changes.
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ inviteCode: code }));

    expect(row.metadata).not.toContain(code);
  });

  // Techlead-2 measured five ways a code still reaches the row after `inviteCode`
  // leaves the allowlist, because the allowlist filters TOP-LEVEL KEYS ONLY.
  // Every allowlisted key that accepts free text is a carrier, and so is any
  // nested object or array under one. Each case here failed before the value
  // pattern was added.
  //
  // Enumerated from ALLOWED_KEYS rather than hand-picked: a key added later is
  // covered the day it is added, which a fixed list of favourites would not be.
  describe.each(
    [...ALLOWED_KEYS].filter(
      // `changes` gets its own case below — it is the one key with special
      // handling, so asserting it here would test the wrong code path.
      (key) => key !== "changes"
    )
  )("carried under an allowlisted key: %s", (key) => {
    test("a bare invite code is redacted", async () => {
      const code = Invite.makeCode();
      const row = await storedFor(auditEvent({ [key]: code }));
      expect(row.metadata).not.toContain(code);
    });

    test("a code embedded in a sentence is redacted", async () => {
      // A whole-value match would pass the case above and miss this one.
      const code = Invite.makeCode();
      const row = await storedFor(
        auditEvent({ [key]: `invite ${code} was sent` })
      );
      expect(row.metadata).not.toContain(code);
    });

    test("a code CONCATENATED onto a word is redacted", async () => {
      // Techlead FINDING-1, and the case a `\b` anchor fails: `\b` requires a
      // non-word character before the match, so `token<code>` — no separator at
      // all — slipped through entirely. Measured: four of five probe shapes
      // leaked, `_<code>` among them, because `_` is a word character.
      const code = Invite.makeCode();
      const row = await storedFor(auditEvent({ [key]: `token${code}` }));
      expect(row.metadata).not.toContain(code);
    });
  });

  // #118 (closing #99 and #101). The numeric classes again, and the negative
  // fixtures carry the weight: three of the four findings were about matching
  // too much or too little, so a test that only asserts redaction proves
  // nothing about either.
  describe("numeric PII: fullwidth digits and long runs (#118)", () => {
    const scrubbed = async (value) =>
      (await storedFor(auditEvent({ name: value }))).metadata;

    describe("#99 — fullwidth digits", () => {
      test.each([
        ["national id", "１２３４５６７８９０１２３", "thai_national_id"],
        ["phone number", "０８１２３４５６７８", "phone_th"],
        ["card number", "４１１１１１１１１１１１１１１１", "credit_card"],
      ])("redacts a fullwidth %s", async (_label, value, klass) => {
        const row = await scrubbed(value);
        expect(row).not.toContain(value);
        expect(row).toContain(`[redacted:${klass}]`);
      });

      test("redacts a number mixing fullwidth and ASCII digits", async () => {
        // Nothing forces a typist to be consistent, and a pattern that only
        // handled uniform runs would miss the realistic case.
        const row = await scrubbed("０81234567８");
        expect(row).toContain("[redacted:phone_th]");
      });

      test("leaves fullwidth TEXT alone", async () => {
        // The classes were widened; the string is not normalised. A workspace
        // named in fullwidth letters is stored as the user typed it.
        const row = await scrubbed("ｆｕｌｌｗｉｄｔｈ");
        expect(row).toContain("ｆｕｌｌｗｉｄｔｈ");
      });
    });

    describe("#101 — runs longer than any classified length", () => {
      test.each([
        ["17 digits", "12345678901234567"],
        ["20 digits", "12345678901234567890"],
        ["32 digits", "12345678901234567890123456789012"],
        ["17 fullwidth digits", "１２３４５６７８９０１２３４５６７"],
      ])("redacts %s", async (_label, value) => {
        const row = await scrubbed(`id ${value} end`);
        expect(row).not.toContain(value);
        expect(row).toContain("[redacted:long_digit_run]");
      });

      test("does NOT swallow a 16-digit card — the specific label wins", async () => {
        // Not an ordering test: measured, the two patterns are disjoint,
        // because the digit lookarounds stop `credit_card` matching inside a
        // 17+ run and stop this one matching 16 or fewer. Moving it to the
        // front changes nothing, and the first version of this comment claimed
        // otherwise until a mutation showed it.
        //
        // What it DOES pin is the label, which is what breaks if someone
        // relaxes those lookarounds.
        const row = await scrubbed("4111111111111111");
        expect(row).toContain("[redacted:credit_card]");
        expect(row).not.toContain("long_digit_run");
      });

      test("does NOT swallow a 13-digit national id", async () => {
        const row = await scrubbed("1234567890123");
        expect(row).toContain("[redacted:thai_national_id]");
        expect(row).not.toContain("long_digit_run");
      });
    });

    describe("#120 — the separator class, isolated", () => {
      // #118 widened the DIGITS to fullwidth and left the punctuation ASCII.
      // Every fixture here holds the same sixteen digits and varies ONLY the
      // character between the groups, because #118's own tests used ASCII
      // separators throughout and would have passed either way — which is why
      // this was found by review rather than by the suite.
      const CARD = ["1234", "5678", "9012", "3456"];
      const FULLWIDTH = ["１２３４", "５６７８", "９０１２", "３４５６"];
      const joined = (groups, separator) => groups.join(separator);

      describe("separators that MUST redact", () => {
        test.each([
          ["U+0020 space", " "],
          ["U+002D hyphen-minus", "-"],
          ["U+00A0 no-break space", "\u00A0"],
          ["U+2009 thin space", "\u2009"],
          ["U+202F narrow no-break space", "\u202F"],
          ["U+3000 ideographic space", "\u3000"],
          ["U+2010 hyphen", "\u2010"],
          ["U+2011 non-breaking hyphen", "\u2011"],
          ["U+2012 figure dash", "\u2012"],
          ["U+2013 en dash", "\u2013"],
          ["U+2014 em dash", "\u2014"],
          ["U+2015 horizontal bar", "\u2015"],
          ["U+2212 minus sign", "\u2212"],
          ["U+FF0D fullwidth hyphen-minus", "\uFF0D"],
        ])("%s, with ASCII digits", async (_label, separator) => {
          const row = await scrubbed(joined(CARD, separator));
          expect(row).toContain("[redacted:credit_card]");
        });

        test.each([
          ["U+3000 ideographic space", "\u3000"],
          ["U+FF0D fullwidth hyphen-minus", "\uFF0D"],
        ])("%s, with FULLWIDTH digits — the realistic IME case", async (_l, sep) => {
          const row = await scrubbed(joined(FULLWIDTH, sep));
          expect(row).toContain("[redacted:credit_card]");
        });

        test("separators MIXED within one number", async () => {
          // The fixture a per-codepoint fix passes and a class fix does not:
          // nothing makes a typist consistent, and an IME switched mid-number
          // produces exactly this.
          const row = await scrubbed("1234 5678\uFF0D9012\u30003456");
          expect(row).toContain("[redacted:credit_card]");
        });

        test("BOTH commas are OUT — proposed as IN, reversed on measurement", async () => {
          // They were in the contract and are not in the class. A comma between
          // numbers is how a LIST is written: measured, adding it caught
          // `ids: 1001,1002,1003,1004`, `1000,2000,3000,4000`, chunk sizes and
          // order ids — none of which the pattern touched before. Same argument
          // as newline. Both widths go out together, so the symmetry that
          // motivated adding the ASCII one is preserved.
          for (const list of [
            "ids: 1001,1002,1003,1004",
            "1000,2000,3000,4000",
            "chunk 4096,8192,1024,2048",
            "価格 1200\uFF0C3400\uFF0C5600\uFF0C7800",
          ]) {
            const row = await scrubbed(list);
            expect(row).not.toContain("[redacted:credit_card]");
          }
        });
      });

      describe("separators that must NOT redact — the class has to mean something", () => {
        test.each([
          ["newline", "\n"],
          ["tab", "\t"],
          ["U+FF1A fullwidth colon", "\uFF1A"],
          ["U+FF1D fullwidth equals", "\uFF1D"],
          ["U+FF3F fullwidth low line", "\uFF3F"],
          ["U+FF0E fullwidth full stop", "\uFF0E"],
          ["U+002C comma", ","],
          ["U+FF0C fullwidth comma", "\uFF0C"],
          ["ASCII full stop", "."],
          ["solidus", "/"],
        ])("%s does not join four digit groups into a card", async (_l, sep) => {
          const row = await scrubbed(joined(CARD, sep));
          expect(row).not.toContain("[redacted:credit_card]");
        });

        test("newline is EXCLUDED as a decision, not an oversight", async () => {
          // Four numeric columns down a log are not one card number. A class
          // matching any Unicode whitespace would let an ordinary tabular log
          // redact itself, which destroys the log without protecting anyone.
          const row = await scrubbed("1234\n5678\n9012\n3456");
          expect(row).not.toContain("[redacted:credit_card]");
          expect(row).toContain("1234");
        });
      });

      describe("controls that must not move", () => {
        test("sixteen CONTIGUOUS digits still redact", async () => {
          const row = await scrubbed("4111111111111111");
          expect(row).toContain("[redacted:credit_card]");
        });

        test("ordinary text carrying an IN separator is untouched", async () => {
          // The over-redaction control PMO asked for. This class has NO Luhn
          // check (see "no checksum validation, deliberately" below), so EVERY
          // separator admitted here widens what it can falsely catch. That is
          // why both commas were reversed out after measurement rather than
          // kept on the symmetry argument. What must not happen is a sentence
          // redacting because it contains a dash.
          const row = await scrubbed("release 1.16.1\u2013stable, built 2026");
          expect(row).not.toContain("[redacted:credit_card]");
        });

        test("the separator class is a SET, never a range", async () => {
          // The failure mode this class invites: written with literal
          // characters, `[ -\u3000]` is a RANGE from space to the ideographic
          // space, covering `.`, `/`, `:` and every ASCII letter — the class
          // silently becomes "any character" while still looking like a list.
          // Measured while mutating: a literal-written variant redacted
          // `1234.5678.9012.3456` as a card. Asserted on the compiled pattern
          // so the shape is pinned, not merely the symptoms above.
          const { PATTERNS } = require("../../../utils/events/redaction");
          const source = PATTERNS.find((p) => p.name === "credit_card").re()
            .source;
          const classes = source.match(/\[(?:\\u[0-9A-Fa-f]{4})+\]\?/g) ?? [];
          expect(classes.length).toBe(3);
          expect(source).not.toMatch(/\[[^\]]*[^\\]-[^\]]*\]\?/);
        });

        test("a date-like group is not swallowed by the new separators", async () => {
          const row = await scrubbed("2026\uFF0D09\uFF0D02");
          expect(row).not.toContain("[redacted:credit_card]");
        });
      });
    });

    describe("#131 — one invisible character defeated every pattern", () => {
      // A single format character inside a value made it invisible to every
      // pattern here, and the row then recorded `redactions: []` — positive
      // evidence of cleanliness that was false. Twelve codepoints were measured
      // leaking before the fix; each is named so a regression says WHICH one.
      //
      // Not NFKC. `redaction.js` rejects normalisation for a reason that still
      // holds: NFKC changes LENGTH (`ﬁ`→`fi`, `㍿`→`株式会社`), so mapping a
      // scrubbed offset back is unsound. Stripping these is different in kind —
      // measured, every one is length-reducing by exactly 1 and nothing is
      // substituted.
      const INVISIBLE = [
        ["U+200B zero-width space", "\u200B"],
        ["U+200C zero-width non-joiner", "\u200C"],
        ["U+200D zero-width joiner", "\u200D"],
        ["U+2060 word joiner", "\u2060"],
        ["U+FEFF byte-order mark", "\uFEFF"],
        ["U+00AD soft hyphen", "\u00AD"],
        ["U+180E Mongolian vowel separator", "\u180E"],
        ["U+034F combining grapheme joiner", "\u034F"],
        ["U+200E left-to-right mark", "\u200E"],
        ["U+061C Arabic letter mark", "\u061C"],
        ["U+2066 left-to-right isolate", "\u2066"],
        ["U+FFF9 interlinear annotation anchor", "\uFFF9"],
        // TL-2: `Mn`, so `\p{Cf}` alone walks past all three.
        ["U+17B4 Khmer inherent vowel AQ", "\u17B4"],
        ["U+17B5 Khmer inherent vowel AA", "\u17B5"],
        // TL-2: `Cf` but NOT Default_Ignorable, so that property alone misses it.
        ["U+0600 Arabic number sign", "\u0600"],
        ["U+13430 Egyptian hieroglyph vertical joiner", "\u{13430}"],
      ];

      // The secret half of each value — what must not survive. Split at the
      // point the character is inserted, so the assertion is about the VALUE
      // rather than about the redaction marker.
      const SECRETS = [
        ["national id", "1234567", "890123", "thai_national_id"],
        ["phone", "08123", "45678", "phone_th"],
        ["card", "4111111111", "111111", "credit_card"],
        ["credential", "apw-inv-ABCDEFGH", "IJKLMNOP", "credential"],
      ];

      describe.each(INVISIBLE)("%s", (_label, mark) => {
        test.each(SECRETS)(
          "a %s carrying it is redacted, and the digits are GONE",
          async (_kind, head, tail, klass) => {
            const row = await scrubbed(`${head}${mark}${tail}`);
            // RF-2, as strengthened: `redactions` being non-empty is NOT the
            // assertion. Measured on the unfixed code,
            // `vic<ZWSP>tim@example.com` redacted the domain and left `vic`
            // behind — the array was populated and the row looked handled while
            // the value leaked. So the value is what gets asserted.
            expect(row).not.toContain(head + mark + tail);
            expect(row).not.toContain(tail);
            expect(row).toContain(`[redacted:${klass}]`);
          }
        );

        test("an email carrying it is redacted in BOTH halves", async () => {
          // Split-local and split-domain are different failures and only one of
          // them was in the original report. Measured before the fix:
          // `vic<ZWSP>tim@example.com` -> `vic<ZWSP>[redacted:email]` (partial,
          // and it LOOKS handled); `victim@exa<ZWSP>mple.com` -> untouched.
          for (const value of [
            `vic${mark}tim@example.com`,
            `victim@exa${mark}mple.com`,
          ]) {
            const row = await scrubbed(value);
            expect(row).not.toContain("victim");
            // TL-2 (1): `vic` is the fragment that survived, and it survived
            // alongside `redactions: ["email"]`. Matched rather than
            // contained, so a `vic` anywhere in the row fails.
            expect(row).not.toMatch(/vic/);
            expect(row).toContain("[redacted:email]");
          }
        });
      });

      test("TL-2 (1): the leaked TAIL is gone, not merely relabelled", async () => {
        // Measured before the fix: a 20-digit run split by a ZWSP came back as
        // `[redacted:credit_card]<ZWSP>67890` — the WRONG class, with the tail
        // still in the row. A test asserting `redactions` contains something,
        // or that the row contains a marker, is green on exactly that output.
        const row = await scrubbed("12345678901234567890".slice(0, 15) + "\u200B67890");
        expect(row).not.toContain("67890");
        expect(row).toContain("[redacted:long_digit_run]");
        expect(row).not.toContain("[redacted:credit_card]");
      });

      test("TL-2 (4): several classes in ONE string are each cut in the right place", async () => {
        // Where an offset bug would show. The patterns replace one after another
        // on a string whose length changes as they go, so a later `optimise this`
        // that reintroduces offset arithmetic against the ORIGINAL cuts in the
        // wrong place — measured by TL-2: a stripped offset applied to the
        // original slices one character short per stripped codepoint.
        const row = await scrubbed(
          "id 1234567\u200B890123 phone 08123\u200B45678 card 4111111111\u200B111111 code apw-inv-ABCDEFGH\u200BIJKLMNOP"
        );
        for (const secret of [
          "890123",
          "45678",
          "111111",
          "IJKLMNOP",
          "1234567",
          "08123",
        ])
          expect(row).not.toContain(secret);
        for (const klass of [
          "thai_national_id",
          "phone_th",
          "credit_card",
          "credential",
        ])
          expect(row).toContain(`[redacted:${klass}]`);
        // and the surrounding words survive — over-redaction is a real cost
        for (const word of ["id", "phone", "card", "code"])
          expect(row).toContain(word);
      });

      test("TL-2 (5): the strip reaches a string nested three arrays deep", async () => {
        // It lives in `scrubString`, not in `redactEventData`. `scrubValue`
        // walks every depth and `scrubChanges` has its own path, so a strip at
        // the top level would miss everything below it.
        const { redactEventData } = require("../../../utils/events/redaction");
        // `embeddedFiles` rather than an invented key: an allowlisted key is
        // required or the value is DROPPED before any scrub runs, and a test
        // that passes because the whole branch was discarded proves nothing
        // about the strip.
        const { data, redactions } = redactEventData({
          embeddedFiles: [[["note 1234567\u200B890123"]]],
        });
        expect(JSON.stringify(data)).toContain("[[["); // the branch survived
        expect(JSON.stringify(data)).not.toContain("890123");
        expect(redactions).toContain("thai_national_id");
      });

      test("TL-2 (5): the strip reaches a non-PII field inside `changes`", async () => {
        const { redactEventData } = require("../../../utils/events/redaction");
        const { data } = redactEventData({
          changes: { name: "note 1234567\u200B890123" },
        });
        expect(JSON.stringify(data)).not.toContain("890123");
      });

      test("TL-2 (6): CONTROL — `dropped` counts a key with an invisible character exactly as before", async () => {
        // Key names deliberately do not go through `scrubString` (#71: echoing a
        // name back walks PII past both guards, so only the COUNT is kept). A
        // strip that leaked onto the key path would change behaviour nobody
        // asked for.
        const { redactEventData } = require("../../../utils/events/redaction");
        const before = redactEventData({ notAnAllowedKey: 1 });
        const after = redactEventData({ "notAnAllowed\u200BKey": 1 });
        expect(after.dropped.length).toBe(before.dropped.length);
        expect(after.data._droppedKeyCount).toBe(before.data._droppedKeyCount);
        expect(JSON.stringify(after.data)).not.toContain("notAnAllowed");
      });

      test("the nested `changes` path #71 exists to close is covered too", async () => {
        const { redactEventData } = require("../../../utils/events/redaction");
        const { data, redactions } = redactEventData({
          changes: { code: "apw-inv-ABCDEFGH\u200BIJKLMNOP" },
        });
        expect(JSON.stringify(data)).not.toContain("IJKLMNOP");
        expect(redactions).toContain("credential");
      });

      describe("per-match: only the matched span is rewritten (QA-2 F1)", () => {
        const { scrubValue } = require("../../../utils/events/redaction");
        const scrub = (value) => scrubValue(value, new Set(), 0);

        test("invisible characters OUTSIDE the match survive a redaction", async () => {
          // A whole-string strip loses them all: one hit anywhere rewrote the
          // entire value. Measured — a field holding Thai text plus a national
          // id came back with all four ICU word-boundary marks gone.
          const value =
            "สวัสดี\u200Bครับ\u200Bยินดี\u200Bต้อนรับ id 1234567\u200B890123";
          const out = scrub(value);
          // THREE, not four. The fourth is INSIDE the national id, where the
          // character was the disguise rather than content — it goes with the
          // value it was hiding. The three word marks outside the match are the
          // ones that must survive.
          expect(out.match(/\u200B/g) ?? []).toHaveLength(3);
          expect(out).toContain("สวัสดี\u200Bครับ\u200Bยินดี\u200Bต้อนรับ");
          expect(out).toContain("[redacted:thai_national_id]");
          expect(out).not.toContain("890123");
        });

        test("a variation selector next to PII keeps its emoji intact", async () => {
          // The reason this ruling is not about Thai. U+FE0F is
          // Default_Ignorable, so a whole-string strip turns ❤️ into ❤ and 1️⃣
          // into 1 — a field is silently re-rendered because something else in
          // it was PII.
          const out = scrub("❤️ 1️⃣ ok id 1234567\u200B890123");
          expect(out).toContain("❤️");
          expect(out).toContain("1️⃣");
          expect(out).toContain("[redacted:thai_national_id]");
        });

        test("an invisible character immediately BEFORE and AFTER a match survives", async () => {
          const out = scrub("a\u200B0812345678\u200Bb");
          expect(out).toBe("a\u200B[redacted:phone_th]\u200Bb");
        });

        test("a RUN of invisible characters on both sides survives", async () => {
          const out = scrub("\u200B\u200C0812345678\u200D\uFEFF");
          expect(out).toBe("\u200B\u200C[redacted:phone_th]\u200D\uFEFF");
        });

        test("three classes in one string are each cut in the right place", async () => {
          const out = scrub(
            "id 1234567\u200B890123 | phone 08123\u200B45678 | code apw-inv-ABCDEFGH\u200BIJKLMNOP"
          );
          expect(out).toBe(
            "id [redacted:thai_national_id] | phone [redacted:phone_th] | code [redacted:credential]"
          );
        });

        test("NON-BMP: a separator outside the BMP does not corrupt the span", async () => {
          // TL-2 condition 4. U+13430 is a Cf codepoint above U+FFFF, so it is
          // TWO code units. An origin map that counts codepoints while the
          // string is indexed in code units slides by one per astral character
          // and slices into the middle of a surrogate pair — which produces a
          // lone surrogate rather than an error, so it corrupts silently.
          const out = scrub("x\u{13430}1234567\u{13430}890123x");
          expect(out).toBe("x\u{13430}[redacted:thai_national_id]x");

          // An astral separator alone does NOT distinguish the two maps —
          // measured, a codepoint-counted map produces the same answer here,
          // because the only astral characters are the ones being removed.
          // What separates them is astral CONTENT that SURVIVES before the
          // match: each one costs the map a unit, so the cut slides left.
          // Measured on that mutant: "😀😀 id 12[redacted:…]ail".
          const withContent = scrub(
            "\u{1F600}\u{1F600} id 1234567\u200B890123 tail"
          );
          expect(withContent).toBe(
            "\u{1F600}\u{1F600} id [redacted:thai_national_id] tail"
          );
          // no lone surrogate anywhere in the output
          expect(out).toBe(out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "!"));
        });

        test("OVERLAP: the first pattern in the list claims the span, and the label says so", async () => {
          // `thai_national_id` precedes `credit_card`, and 13 digits satisfy
          // both (`credit_card` reads them as 4+4+4+1). The order is what
          // decides, so the label is asserted rather than merely the fact that
          // something was redacted.
          const out = scrub("1234567\u200B890123");
          expect(out).toContain("[redacted:thai_national_id]");
          expect(out).not.toContain("[redacted:credit_card]");
        });
      });

      describe("what must NOT change", () => {
        test("Thai text carrying U+200B from TextSplitter is byte-identical", async () => {
          // `utils/TextSplitter/index.js:176` inserts U+200B at ICU word
          // boundaries on purpose, because Thai has no spaces between words. A
          // strip that rewrote every value would corrupt our own output, so the
          // stripped copy is used to MATCH and the original is what survives
          // when nothing matches.
          const { scrubValue } = require("../../../utils/events/redaction");
          const thai = "สวัสดี\u200Bครับ\u200Bยินดีต้อนรับ";
          expect(scrubValue(thai, new Set(), 0)).toBe(thai);
        });

        test("a value with an invisible character but no PII is untouched", async () => {
          const { scrubValue } = require("../../../utils/events/redaction");
          const value = "workspace\u200Bname\u00ADhere";
          expect(scrubValue(value, new Set(), 0)).toBe(value);
        });

        test("a value with no invisible character at all is untouched", async () => {
          const { scrubValue } = require("../../../utils/events/redaction");
          expect(scrubValue("ordinary name", new Set(), 0)).toBe(
            "ordinary name"
          );
        });

        test("Thai and Vietnamese DIACRITICS are not stripped, even beside PII", async () => {
          // The class is a union of two properties and deliberately not
          // `\p{Mn}` at large. Measured: 1818 `Mn` codepoints defeat a pattern,
          // but they include every Thai and Vietnamese mark — stripping those
          // turns `สวัสดีครับ` into `สวสดครบ`.
          //
          // This is the test that separates "invisible" from "combining". It has
          // to sit beside a real redaction, because a value with no hit is
          // returned untouched anyway and would pass whatever the class does.
          const { scrubValue } = require("../../../utils/events/redaction");
          const hits = new Set();
          const out = scrubValue(
            "สวัสดีครับ Tiếng Việt id 1234567\u200B890123",
            hits
          , 0);
          expect(out).toContain("สวัสดีครับ");
          expect(out).toContain("Tiếng Việt");
          expect(out).toContain("[redacted:thai_national_id]");
          expect(out).not.toContain("890123");
        });

        test("nothing is flagged merely for containing an invisible character", async () => {
          // Proposed and declined. TextSplitter produces these legitimately, so
          // the flag would fire on our own output — and #94's lesson is that a
          // signal firing on correct input gets ignored. Recorded as a decision.
          const { redactEventData } = require("../../../utils/events/redaction");
          const { redactions } = redactEventData({
            name: "สวัสดี\u200Bครับ",
          });
          expect(redactions).toEqual([]);
        });
      });
    });

    describe("no checksum validation, deliberately", () => {
      // Thai mod-11 removes only ~9% of timestamp false positives (measured:
      // 18,184 of 200,000), and Luhn does not remove the migration-id one at
      // all — `20260902050000` passes it. What a checksum WOULD do is make the
      // pattern fail open on real PII that is mistyped, and a national id with
      // one digit wrong is still a national id someone typed about themselves.
      //
      // These two tests fail loudly if a checksum is ever added.
      test("redacts a Thai national id with a VALID checksum", async () => {
        const row = await scrubbed("1101700000001");
        expect(row).toContain("[redacted:thai_national_id]");
      });

      test("redacts a Thai national id with an INVALID checksum", async () => {
        const row = await scrubbed("1234567890123");
        expect(row).toContain("[redacted:thai_national_id]");
      });

      test("redacts a card number failing Luhn", async () => {
        const row = await scrubbed("4111111111111112");
        expect(row).toContain("[redacted:credit_card]");
      });
    });

    describe("known false positives, asserted so the decision is pinned (#100)", () => {
      // #100 stays OPEN. These assert what happens TODAY, so the deferral is
      // recorded rather than assumed — and so that whoever implements the
      // key-context fix sees exactly which tests they are changing.
      test("a 13-digit ms timestamp is still redacted as a national id", async () => {
        const row = await scrubbed(`createdAt ${Date.now()}`);
        expect(row).toContain("[redacted:thai_national_id]");
      });

      test("a 14-digit migration id is still redacted as a card", async () => {
        // Residual declared on #118: narrowing the 13-16 card range to exclude
        // 14 would stop matching real cards.
        const row = await scrubbed("20260902100000_add_index");
        expect(row).toContain("[redacted:credit_card]");
      });
    });

    describe("negative control — a redactor that matches everything is not a redactor", () => {
      test.each([
        ["an ordinary word", "ordinary_workspace_name"],
        ["a version string", "release 1.16.1 shipped"],
        ["a uuid", "550e8400-e29b-41d4-a716-446655440000"],
        ["a short number", "port 3001"],
        ["a year", "since 2026"],
      ])("leaves %s untouched", async (_label, value) => {
        expect(await scrubbed(value)).toContain(value);
      });
    });
  });

  // O5b (#94) FINDING: the same `\b` failure, one class over. The three NUMERIC
  // patterns were anchored with `\b`, and `_` is a word character, so an
  // identifier glued to an underscore kept its value in full. Found by the
  // bundle's whole-string scan, where an event name `note_<13 digits>` survived
  // while every other seeded marker was removed. These four hold the digit
  // lookarounds that replaced it: three that must redact, one that must not,
  // because a bound that matches everything is not a bound.
  describe("PDPA numbers glued to an identifier (#94)", () => {
    test("a Thai national ID after an underscore is redacted", async () => {
      const row = await storedFor(auditEvent({ name: "note_1234567890123" }));
      expect(row.metadata).not.toContain("1234567890123");
      expect(row.metadata).toContain("[redacted:thai_national_id]");
    });

    test("a Thai phone number after an underscore is redacted", async () => {
      const row = await storedFor(auditEvent({ name: "user_0812345678" }));
      expect(row.metadata).not.toContain("0812345678");
      expect(row.metadata).toContain("[redacted:phone_th]");
    });

    test("a card number concatenated onto a word is redacted", async () => {
      const row = await storedFor(auditEvent({ name: "id4111111111111111" }));
      expect(row.metadata).not.toContain("4111111111111111");
      expect(row.metadata).toContain("[redacted:credit_card]");
    });

    test("an ordinary word with no digits is left alone", async () => {
      const row = await storedFor(auditEvent({ name: "ordinary_workspace_name" }));
      expect(row.metadata).toContain("ordinary_workspace_name");
    });
  });

  test("a code inside `changes` is redacted", async () => {
    // `changes` is scrubbed by scrubChanges, a different function from the one
    // every other key goes through — so it needs its own case or half the
    // redaction code is unproven.
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ changes: { code } }));
    expect(row.metadata).not.toContain(code);
  });

  test("a code nested in an object is redacted", async () => {
    const code = Invite.makeCode();
    const row = await storedFor(
      auditEvent({ embeddedFiles: { invite: { url: `/accept/${code}` } } })
    );
    expect(row.metadata).not.toContain(code);
  });

  test("a code inside an array is redacted", async () => {
    const code = Invite.makeCode();
    const row = await storedFor(auditEvent({ changes: { invites: [code] } }));
    expect(row.metadata).not.toContain(code);
  });

  test("QA-3: the accept-invite URL the frontend builds is redacted", async () => {
    // Not a hypothetical shape. `NewInviteModal/index.jsx:41,86` composes exactly
    // this URL to put on the clipboard, so it is the string most likely to be
    // passed to an audit call site by someone reaching for "the invite link".
    // `link` is an allowlisted key, so only the value pattern stops it.
    const code = Invite.makeCode();
    const row = await storedFor(
      auditEvent({ link: `https://workspace.example.com/accept-invite/${code}` })
    );

    expect(row.metadata).not.toContain(code);
    // The surrounding URL survives — redaction removes the credential, not the
    // fact that a link was involved.
    expect(row.metadata).toContain("[redacted:credential]");
  });

  test("every issued apw- credential is redacted, not just invites", async () => {
    // Same shape, same risk, and none of them was guarded. Each sibling is
    // generated by its REAL function rather than a lookalike string, so the
    // assertion keeps holding if a format changes.
    //
    // `apw-tat-` is here because an explicit three-prefix alternation missed it
    // and review caught it — the reason the pattern now matches the family
    // rather than a list.
    const { ApiKey } = require("../../../models/apiKeys");
    const {
      BrowserExtensionApiKey,
    } = require("../../../models/browserExtensionApiKey");
    const {
      TemporaryAuthToken,
    } = require("../../../models/temporaryAuthToken");

    for (const secret of [
      ApiKey.makeSecret(),
      BrowserExtensionApiKey.makeSecret(),
      TemporaryAuthToken.makeTempToken(),
    ]) {
      const spaced = await storedFor(auditEvent({ name: `key ${secret}` }));
      expect(spaced.metadata).not.toContain(secret);
      // And concatenated, per FINDING-1 — the anchor-free pattern has to hold
      // for the siblings too, not only for invites.
      const glued = await storedFor(auditEvent({ name: `token${secret}` }));
      expect(glued.metadata).not.toContain(secret);
    }
  });

  test("QA-3 R4: the displayed keyPrefix survives, and only just", async () => {
    // `keyPrefix` is an allowlisted audit JOIN KEY — it exists so an operator can
    // tie an event to an API key without holding the key. It is the first
    // DISPLAY_PREFIX_LENGTH (16) characters of the secret, which is `apw-key-`
    // plus 8: exactly one character short of the pattern's {16,} bound.
    //
    // The two numbers are therefore COUPLED, and nothing in the source says so.
    // Raise DISPLAY_PREFIX_LENGTH to 24 and every keyPrefix starts matching the
    // credential pattern — audit rows silently lose their join key, and the
    // suite would stay green because no other test looks at this. This is that
    // test.
    const { ApiKey } = require("../../../models/apiKeys");
    const {
      keyPrefix,
      DISPLAY_PREFIX_LENGTH,
    } = require("../../../utils/apiKeySecurity");

    const prefix = keyPrefix(ApiKey.makeSecret());
    expect(prefix).toHaveLength(DISPLAY_PREFIX_LENGTH);

    const row = await storedFor(auditEvent({ keyPrefix: prefix }));
    expect(JSON.parse(row.metadata).keyPrefix).toBe(prefix);

    // Say the relationship out loud, so a future change to either number fails
    // HERE — where the comment explains it — rather than in a puzzling audit bug.
    // `apw-key-` is 8 characters, and the pattern needs 16 after it.
    expect(DISPLAY_PREFIX_LENGTH - "apw-key-".length).toBeLessThan(16);
  });

  test("`inviteCode` is no longer an allowlisted key at all", async () => {
    // Belt and braces: the pattern would catch the value anyway, but the key
    // must not be a permitted carrier either — two independent guards, which is
    // the design this module already states in its header.
    expect(ALLOWED_KEYS.has("inviteCode")).toBe(false);
    expect(ALLOWED_KEYS.has("inviteId")).toBe(true);
  });

  test("the event still identifies WHICH invite, by id", async () => {
    // Redaction that removes the event's meaning is not a fix. The id ties the
    // row to the invite without carrying anything redeemable — the same trade
    // `keyPrefix` already makes for API keys.
    const row = await storedFor(
      auditEvent({ inviteId: 4242, createdBy: "admin-user" })
    );

    const stored = JSON.parse(row.metadata);
    expect(stored.inviteId).toBe(4242);
    expect(stored.createdBy).toBe("admin-user");
  });
});
