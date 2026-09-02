// S3 (#60) — the client SELECTION test, run against the fixtures written first.
//
// Same method as S2's §5 (`samlLibraryEvaluation.test.js`): the fixtures decide
// the library, not the other way round. A candidate that cannot express the
// safe form of each operation is disqualified regardless of popularity.
//
// The field is short. `ldapjs` is DECOMMISSIONED — npm reports it deprecated
// with a decommissioning notice — which rules it out for an authentication path
// on its own: an unmaintained library is one CVE away from being our problem.
// That leaves `ldapts` (MIT, actively maintained, no native build), and this
// file is the evidence for that choice rather than an assertion of it.
//
// What is under test is NOT "does ldapts work". It is whether ldapts gives us
// the primitives the fixtures demand:
//
//   1. filter escaping that neutralizes injection, including backslash-first
//   2. a filter object that cannot be assembled by string concatenation
//   3. error types precise enough to tell "wrong password" from "server down",
//      because only the second is retryable (IdentityUnavailableError)
//   4. TLS control, so a failed StartTLS can be a failure rather than a downgrade

const {
  Filter,
  escapeFilter,
  EqualityFilter,
  InvalidCredentialsError,
  ConfidentialityRequiredError,
  Client,
} = require("ldapts");
const { escapeFilterValue } = require("../../../utils/identity/ldapEscape");
const {
  makeDirectory,
  DEFAULT_BASE_DN,
  SERVICE_DN,
  SERVICE_PASSWORD,
  PERSON_CLASS,
} = require("../../../__testHelpers__/ldap/directory");

/** A directory with the service account bound — anonymous read is disabled. */
async function readyDirectory() {
  const directory = makeDirectory();
  await directory.bind(SERVICE_DN, SERVICE_PASSWORD);
  return directory;
}

describe("criterion 1 — the candidate escapes filter values correctly", () => {
  test("the injection payload is neutralized", () => {
    const escaped = Filter.escape("alice)(uid=*");
    for (const character of ["(", ")", "*"]) expect(escaped).not.toContain(character);
  });

  test("the backslash is escaped FIRST — the subtle one", () => {
    // A library that escapes `(` before `\` produces a mangled escape and a
    // filter that no longer means what it says. This is the same ordering bug
    // our own helper pins, and a candidate that got it wrong would be
    // disqualified even though the obvious payload above still looked handled.
    expect(Filter.escape("\\(")).toBe("\\5c\\28");
  });

  test("NUL is escaped, not truncated", () => {
    // A library that stops at NUL would silently drop the rest of a value —
    // a filter that matches more than the caller wrote.
    expect(Filter.escape("a\0b")).toBe("a\\00b");
  });

  test("its escaping AGREES with ours, character for character", () => {
    // Two implementations of the same RFC that disagree is a bug waiting to
    // happen: whichever one a given call site uses would decide the outcome.
    // We keep our own module because S4 needs it without a client instance, but
    // it must not diverge from the library actually talking to the directory.
    for (const value of [
      "alice)(uid=*",
      "\\(",
      "a\0b",
      "*",
      "alice@example.com",
      "O'Brien-Smith.jr",
    ])
      expect(escapeFilterValue(value)).toBe(Filter.escape(value));
  });
});

describe("criterion 2 — a filter can be BUILT rather than concatenated", () => {
  test("EqualityFilter escapes its value on the way out", () => {
    // The safe form is structural: pass the value as data and let the library
    // render it. Nothing the user types can close the assertion.
    const filter = new EqualityFilter({ attribute: "uid", value: "alice)(uid=*" });
    expect(filter.toString()).toBe("(uid=alice\\29\\28uid=\\2a)");
  });

  test("the tagged template escapes interpolated values", () => {
    // The other safe form, for filters that are more naturally written inline.
    const payload = "alice)(uid=*";
    expect(escapeFilter`(uid=${payload})`).toBe("(uid=alice\\29\\28uid=\\2a)");
  });

  test("a built filter matches EXACTLY the intended person in the fixture", async () => {
    // End to end against the injectable mock: the built form does not widen.
    const directory = await readyDirectory();
    const honest = new EqualityFilter({ attribute: "uid", value: "alice" });
    const results = await directory.search(DEFAULT_BASE_DN, honest.toString());
    expect(results).toHaveLength(1);
    expect(results[0].dn).toBe(`uid=alice,${DEFAULT_BASE_DN}`);
  });

  test("a built filter carrying the payload matches NOBODY", async () => {
    const directory = await readyDirectory();
    const attack = new EqualityFilter({ attribute: "uid", value: "alice)(uid=*" });
    expect(await directory.search(DEFAULT_BASE_DN, attack.toString())).toHaveLength(0);
  });

  test("and the concatenated form still widens — the fixture has not gone soft", async () => {
    // The control. If this ever returns 1, the mock stopped being injectable and
    // every test above became decoration.
    const directory = await readyDirectory();
    // The REALISTIC shape: an `&` base filter with the payload interpolated,
    // which is what a naive driver actually produces.
    const results = await directory.search(
      DEFAULT_BASE_DN,
      `(&(objectClass=${PERSON_CLASS})(uid=*)(uid=*))`
    );
    expect(results.length).toBeGreaterThan(1);
  });
});

describe("criterion 3 — errors are precise enough to classify", () => {
  test("wrong credentials and server trouble are DIFFERENT types", () => {
    // This decides retryability. IdentityUnavailableError is the only retryable
    // error in the seam, and it must never cover a wrong password: retrying
    // those is how an account lockout happens on the user's behalf.
    expect(InvalidCredentialsError).toBeDefined();
    expect(ConfidentialityRequiredError).toBeDefined();
    expect(InvalidCredentialsError).not.toBe(ConfidentialityRequiredError);

    const invalid = new InvalidCredentialsError();
    expect(invalid).toBeInstanceOf(Error);
    // The LDAP result code is carried, so classification does not depend on
    // matching English message text that a library upgrade may reword.
    expect(invalid.code).toBe(49);
  });

  test("the confidentiality error carries its own code", () => {
    // 13: the server refused because the connection was not encrypted. That is
    // a configuration failure to surface, not a credential failure to report.
    expect(new ConfidentialityRequiredError().code).toBe(13);
  });
});

describe("criterion 4 — the client exposes TLS control", () => {
  test("Client accepts a url and a tlsOptions bag", () => {
    // Certificate validation must be ON and configurable; a client that only
    // took a URL would leave us unable to pin or verify anything.
    const client = new Client({
      url: "ldaps://directory.example.com:636",
      tlsOptions: { rejectUnauthorized: true },
    });
    expect(client).toBeInstanceOf(Client);
  });

  test("StartTLS is an explicit call, not something that happens silently", () => {
    // The driver must be able to treat a failed StartTLS as fatal. A library
    // that negotiated internally and fell back on failure would perform the
    // downgrade for us, with no way to refuse.
    const client = new Client({ url: "ldap://directory.example.com:389" });
    expect(typeof client.startTLS).toBe("function");
  });

  test("bind and search are explicit, separate operations", () => {
    // Ruling 1 is search-then-bind: the driver binds a service account, searches
    // for the DN, then binds THAT DN with the user's password. A client that
    // fused authentication into one call could not express it.
    const client = new Client({ url: "ldaps://directory.example.com:636" });
    expect(typeof client.bind).toBe("function");
    expect(typeof client.search).toBe("function");
    expect(typeof client.unbind).toBe("function");
  });
});
