// issue 49, QA-1 pre-read — two latent defects in the token itself.
//
// Neither is reachable today. Both are cheap to close now and expensive to discover later,
// and #49 is the change that makes the first one reachable: it puts a second server-chosen
// field into the same payload and invites a third.
//
// F1 — the signed payload is AMBIGUOUS. `${embedUuid}|${sessionId}|${issuedAt}` uses a
// separator that the fields themselves may contain, so different field values can produce
// the same string to sign. Measured on d39667d:
//
//     sign("A|B", "C", 1) === sign("A", "B|C", 1)   →  true
//
// It does not leak today only because both fields are server-generated UUIDs, which cannot
// contain a pipe. That is a property of today's CALLERS, not of the signing scheme, and it
// is exactly the kind of guarantee that quietly stops holding — the first user-controlled
// field added to this payload turns a formatting detail into token forgery.
//
// F2 — expiry has no UPPER bound. Line 106 checks `now - stamp > TTL` only, so a stamp in
// the future is not old and therefore never expires. A token minted a year ahead verifies
// clean and stays valid for a year. Nothing in-tree mints one, but `issuedAt` is a
// parameter, and a clock that jumps forward once produces tokens that outlive the TTL the
// whole scheme is bounded by.
//
// RED on d39667d: the collision pair is equal, and the future-stamped token is {valid:true}.

process.env.SIG_KEY = process.env.SIG_KEY || "a".repeat(64);

const {
  mintSessionToken,
  verifySessionToken,
  SESSION_TOKEN_TTL_MS,
  SESSION_ABSOLUTE_MAX_MS,
} = require("../../../utils/middleware/embedSessionToken");

const EMBED = "emb-1111-2222-3333";
const SESSION = "123e4567-e89b-42d3-a456-426614174000";

describe("issue 49 F1: the signed payload is unambiguous", () => {
  test("shifting a separator between two fields does not produce the same signature", async () => {
    // The concrete pair, kept as the literal values that were measured rather than
    // generated: this is the proof the scheme is injective, and a reader should be able to
    // see the collision it rules out without running anything.
    const left = mintSessionToken({
      embedUuid: "A|B",
      sessionId: "C",
      issuedAt: 1,
    });
    const right = mintSessionToken({
      embedUuid: "A",
      sessionId: "B|C",
      issuedAt: 1,
    });

    expect(left).not.toEqual(right);
  });

  test("a token for one field split is not accepted for the other", async () => {
    // The consequence rather than the mechanism. A signature collision matters because
    // verification accepts it, and asserting that directly means a future encoding change
    // that is injective but verified against the wrong fields still fails here.
    const token = mintSessionToken({
      embedUuid: "A|B",
      sessionId: "C",
      issuedAt: 1,
    });

    expect(
      verifySessionToken({
        token,
        embedUuid: "A",
        sessionId: "B|C",
        now: 1,
      })
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  test("an ordinary token still verifies — the encoding change is not a lockout", async () => {
    // Positive control. Every assertion above is satisfied by a scheme that verifies
    // nothing, and this is a signing change: getting it wrong invalidates every token in
    // flight, which is a visitor-facing outage rather than a test failure.
    const token = mintSessionToken({ embedUuid: EMBED, sessionId: SESSION });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION })
    ).toEqual({ valid: true });
  });
});

describe("issue 49 F2: expiry is bounded in both directions", () => {
  test("a token stamped far in the future is refused", async () => {
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION }).valid
    ).toBe(false);
  });

  test("a token stamped just beyond the allowed skew is refused", async () => {
    // The boundary, not just the absurd case: a check that only rejects a year ahead would
    // pass the test above and still accept a stamp an hour ahead, which is what a clock jump
    // actually produces.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now + 60 * 60 * 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION, now })
        .valid
    ).toBe(false);
  });

  test("a token a little ahead of this clock is still accepted", async () => {
    // Servers behind a load balancer disagree by seconds. Refusing every future stamp would
    // log visitors out whenever they were served by the machine whose clock runs fast, so
    // the bound is a skew allowance and not zero — asserted, because a stricter check would
    // pass both tests above and cause an intermittent outage nobody could reproduce.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now + 30 * 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION, now })
    ).toEqual({ valid: true });
  });

  test("the past bound still holds — an expired token is refused", async () => {
    // Regression guard: an upper bound added in the wrong branch could replace the lower one
    // rather than join it, and the suite would go green while every old token became valid.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now - SESSION_TOKEN_TTL_MS - 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION, now })
    ).toEqual({ valid: false, reason: "expired" });
  });
});

describe("issue 49 TL-2: the stamps are integers this server could have written", () => {
  const forge = (stamp, origin = stamp) => {
    // Signed with the real key, so the signature is valid and only the stamp is in question.
    // A test that forged an INVALID signature would be refused for the wrong reason and would
    // pass whether or not the stamp is checked at all.
    const crypto = require("crypto");
    const payload = JSON.stringify([EMBED, SESSION, String(stamp), String(origin)]);
    const signature = crypto
      .createHmac("sha256", process.env.SIG_KEY)
      .update(payload)
      .digest("base64url");
    return `${stamp}.${origin}.${signature}`;
  };

  test("a stamp of four hundred nines is refused, not treated as Infinity", async () => {
    // The gap `/^\d+$/` does not close: that pattern rejects "1e999" but this is
    // digits-only, and `Number()` of it is Infinity. An infinite issuedAt is never more than
    // a TTL in the past, so without SOME upper-end check the token would never expire.
    //
    // Two things refuse it today — the isSafeInteger guard and the clock-skew bound — and
    // this test does not care which. That is deliberate: it asserts the behaviour (an
    // Infinity stamp is refused) rather than the mechanism, so either guard may be
    // refactored as long as the token stays refused.
    const token = forge("9".repeat(400));

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION })
    ).toEqual({ valid: false, reason: "malformed" });
  });

  test("a non-numeric stamp is refused", async () => {
    expect(
      verifySessionToken({
        token: forge("1e999"),
        embedUuid: EMBED,
        sessionId: SESSION,
      })
    ).toEqual({ valid: false, reason: "malformed" });
  });

  test("a negative stamp is refused", async () => {
    expect(
      verifySessionToken({
        token: forge("-1"),
        embedUuid: EMBED,
        sessionId: SESSION,
      })
    ).toEqual({ valid: false, reason: "malformed" });
  });

  test("an unparseable firstIssuedAt is refused too, not only issuedAt", async () => {
    // Asserted separately because they are separate fields: a check written for the first
    // stamp and not the second leaves the ABSOLUTE ceiling computable from garbage.
    const now = Date.now();

    expect(
      verifySessionToken({
        token: forge(String(now), "9".repeat(400)),
        embedUuid: EMBED,
        sessionId: SESSION,
        now,
      })
    ).toEqual({ valid: false, reason: "malformed" });
  });
});

describe("issue 49 TL-2: a session has an absolute ceiling, not a rolling one", () => {
  test("a token whose session opened over the maximum ago is refused, however fresh its stamp", async () => {
    // The whole point of the ceiling. `issuedAt` is NOW — this token was minted a second ago
    // and is nowhere near its 24h TTL — but the session behind it opened eight days back.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now,
      firstIssuedAt: now - SESSION_ABSOLUTE_MAX_MS - 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION, now })
    ).toEqual({ valid: false, reason: "expired" });
  });

  test("a session still inside the ceiling keeps working", async () => {
    // Positive control: without it, a ceiling of zero would satisfy the test above and end
    // every session at its first rotation.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now,
      firstIssuedAt: now - SESSION_ABSOLUTE_MAX_MS + 60 * 60 * 1000,
    });

    expect(
      verifySessionToken({ token, embedUuid: EMBED, sessionId: SESSION, now })
    ).toEqual({ valid: true });
  });

  test("firstIssuedAt cannot be rewritten to buy another week", async () => {
    // It is inside the signed payload, so moving it invalidates the signature rather than
    // extending the session. Without that, the ceiling would be advisory.
    const now = Date.now();
    const old = now - SESSION_ABSOLUTE_MAX_MS - 1000;
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now,
      firstIssuedAt: old,
    });
    const [stamp, , signature] = token.split(".");
    const rewritten = `${stamp}.${now}.${signature}`;

    expect(
      verifySessionToken({
        token: rewritten,
        embedUuid: EMBED,
        sessionId: SESSION,
        now,
      })
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  test("a fresh session defaults firstIssuedAt to its own issuedAt", async () => {
    // What a session OPEN means: this is the first token, so the two moments are the same.
    // If they diverged, a brand-new session would start life partway through its ceiling.
    const now = Date.now();
    const token = mintSessionToken({
      embedUuid: EMBED,
      sessionId: SESSION,
      issuedAt: now,
    });

    expect(token.split(".").slice(0, 2)).toEqual([String(now), String(now)]);
  });
});

describe("issue 49 TL-2: the signature comparison is constant time", () => {
  test("a signature differing only in its LAST byte is refused", async () => {
    // A `===` comparison would pass this test, so it is not the assertion by itself — see
    // the source-level check below, which is what actually pins the property. Kept because
    // an implementation that compared only a prefix would fail here and nowhere else.
    const token = mintSessionToken({ embedUuid: EMBED, sessionId: SESSION });
    const [stamp, origin, signature] = token.split(".");
    const flipped =
      signature.slice(0, -1) + (signature.slice(-1) === "A" ? "B" : "A");

    expect(
      verifySessionToken({
        token: `${stamp}.${origin}.${flipped}`,
        embedUuid: EMBED,
        sessionId: SESSION,
      })
    ).toEqual({ valid: false, reason: "mismatch" });
  });

  test("the comparison uses timingSafeEqual, not === or a byte loop", async () => {
    // Timing is not observable from a unit test — a real timing measurement here would be
    // flaky on shared CI and would prove nothing on a fast machine. So the property is
    // pinned at the source: swapping in `===` fails this, which is what was asked for, and
    // it fails loudly rather than becoming a slow leak nobody measures.
    const source = require("fs").readFileSync(
      require.resolve("../../../utils/middleware/embedSessionToken"),
      "utf8"
    );

    expect(source).toContain("crypto.timingSafeEqual");
  });
});
