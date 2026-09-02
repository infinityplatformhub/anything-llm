// S2 (#43) — QA-1 NIT-1: deriving a username from an email must not merge two
// different people, and a collision must be R1's refusal rather than a database
// error that locks out an unrelated account.
//
// The old rule stripped leading characters that were not a-z, so `1alice@`,
// `_alice@` and `alice@` all became `alice@`. The second person to arrive then
// hit the `users.username` unique constraint — surfacing as a flat 401 with no
// explanation, against an account that had done nothing wrong.
//
// This is a shared helper: every driver derives usernames the same way, or S2
// and S3 each invent their own idea of who two people are.

const crypto = require("crypto");
const {
  deriveUsername,
  usernameCandidates,
  normalizeForCompare,
} = require("../../../utils/identity/deriveUsername");

describe("deriveUsername — distinct emails stay distinct", () => {
  test("QA-1 NIT-1: leading characters are preserved, not silently trimmed", () => {
    // Each of these is a DIFFERENT mailbox and must yield a different username.
    const emails = ["alice@corp.com", "1alice@corp.com", "_alice@corp.com"];
    const derived = emails.map((email) => deriveUsername(email));
    expect(new Set(derived).size).toBe(emails.length);
  });

  test("a leading digit or underscore is prefixed, not dropped", () => {
    // The schema wants a leading lowercase letter, so the fix is to ADD one,
    // never to remove what the user actually has.
    expect(deriveUsername("1alice@corp.com")).toMatch(/^[a-z]/);
    expect(deriveUsername("_alice@corp.com")).toMatch(/^[a-z]/);
    expect(deriveUsername("1alice@corp.com")).toContain("1alice");
    expect(deriveUsername("_alice@corp.com")).toContain("_alice");
  });

  test("a non-ASCII local part keeps its identity rather than losing a letter", () => {
    // `álice@` used to become `lice@` — a different name, and one that could
    // collide with a real `lice@`.
    const derived = deriveUsername("álice@corp.com");
    expect(derived).not.toBe(deriveUsername("lice@corp.com"));
    expect(derived).toMatch(/^[a-z][a-z0-9._@-]*$/);
  });

  test("a fully numeric local part does not collapse to the domain", () => {
    // `99@corp.com` used to derive `corp.com`, which is not that person and
    // could belong to somebody else entirely.
    const derived = deriveUsername("99@corp.com");
    expect(derived).not.toBe("corp.com");
    expect(derived).toContain("99");
  });

  test("the result always satisfies the schema's username rule", () => {
    const samples = [
      "alice@corp.com",
      "1alice@corp.com",
      "_alice@corp.com",
      "álice@corp.com",
      "99@corp.com",
      "!!!@corp.com",
      "a@b.co",
      `${"x".repeat(120)}@corp.com`,
    ];
    for (const email of samples) {
      const derived = deriveUsername(email);
      expect(derived).toMatch(/^[a-z][a-z0-9._@-]*$/);
      expect(derived.length).toBeGreaterThanOrEqual(2);
      expect(derived.length).toBeLessThanOrEqual(64);
    }
  });

  test("PMO ruling: case and Unicode form are normalized before comparing", () => {
    // Both sides of a handle comparison must go through the SAME normalization,
    // or `User+X@` and `user+x@` are two handles for one mailbox and the
    // collision rule silently stops firing.
    expect(deriveUsername("User+X@CORP.COM")).toBe(deriveUsername("user+x@corp.com"));

    // Unicode gives the same text two encodings. Lowercasing alone does not
    // reconcile them: composed `\u00e9` sanitizes to one `-`, decomposed
    // `e`+accent to `e-`, so an IdP that emits NFD would derive a different
    // username than the account the person already owns.
    const composed = "caf\u00e9@corp.com";
    const decomposed = "cafe\u0301@corp.com";
    expect(composed).not.toBe(decomposed);
    expect(deriveUsername(composed)).toBe(deriveUsername(decomposed));
  });

  test("normalizeForCompare is the one normalization both sides use", () => {
    // Exported so callers cannot invent a second, subtly different version —
    // which is exactly how the two sides drift apart.
    expect(normalizeForCompare("User+X@CORP.COM")).toBe("user+x@corp.com");
    expect(normalizeForCompare("cafe\u0301")).toBe(normalizeForCompare("caf\u00e9"));
  });

  test("derivation is deterministic — the same email gives the same username", () => {
    // The first candidate must be stable, or a returning user whose link row
    // was lost would get a second account instead of matching their first.
    const email = "alice@corp.com";
    expect(deriveUsername(email)).toBe(deriveUsername(email));
  });

  test("a local part with nothing usable still yields a valid username", () => {
    const derived = deriveUsername("!!!@corp.com");
    expect(derived).toMatch(/^[a-z][a-z0-9._@-]*$/);
    expect(derived.length).toBeGreaterThanOrEqual(2);
  });
});

describe("usernameCandidates — suffix retry", () => {
  test("yields the plain username first, then sso-suffixed alternatives", () => {
    const candidates = [...usernameCandidates("alice@corp.com", 4)];
    expect(candidates[0]).toBe(deriveUsername("alice@corp.com"));
    expect(candidates).toHaveLength(4);
    // The retries exist so a genuine username clash (two different mailboxes
    // that legitimately derive the same handle) creates a second account rather
    // than a 401 against the first person's login.
    for (const candidate of candidates.slice(1)) {
      expect(candidate).toMatch(/-sso-[0-9a-f]{6,}$/);
      expect(candidate).toMatch(/^[a-z][a-z0-9._@-]*$/);
      expect(candidate.length).toBeLessThanOrEqual(64);
    }
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  test("a maximum-length username still leaves room for the suffix", () => {
    const long = `${"x".repeat(120)}@corp.com`;
    for (const candidate of usernameCandidates(long, 3)) {
      expect(candidate.length).toBeLessThanOrEqual(64);
      expect(candidate).toMatch(/^[a-z][a-z0-9._@-]*$/);
    }
  });
});
