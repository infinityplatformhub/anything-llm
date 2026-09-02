// S3 (#60) — RFC 4515 filter escaping.
//
// RED-first: written before the helper exists.
//
// PMO ruling 1: filters are built with escaping, never concatenation. This is
// S3's SQL injection, and the fixture directory is genuinely injectable (see
// ldapDirectoryFixtures.test.js), so a driver that skips this really does
// authenticate the wrong person rather than merely looking careless.
//
// The escaping is its own module because the driver is not the only place a
// user-supplied value reaches a filter — S4's directory sync will need it too,
// and a second implementation is how the two drift.

const {
  escapeFilterValue,
  escapeDn,
} = require("../../../utils/identity/ldapEscape");
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

/** The base filter a real driver writes: an `&` with the object class. */
const baseFilter = (value) => `(&(objectClass=${PERSON_CLASS})(uid=${value}))`;

describe("escapeFilterValue — RFC 4515 §3", () => {
  test("the five special characters become their hex escapes", () => {
    // The exact list the RFC names. Anything less is a filter an attacker can
    // still break out of.
    expect(escapeFilterValue("(")).toBe("\\28");
    expect(escapeFilterValue(")")).toBe("\\29");
    expect(escapeFilterValue("*")).toBe("\\2a");
    expect(escapeFilterValue("\\")).toBe("\\5c");
    expect(escapeFilterValue("\0")).toBe("\\00");
  });

  test("the backslash is escaped FIRST, not last", () => {
    // Order matters and getting it wrong is silent: escaping `(` first turns
    // `\` + `(` into `\` + `\28`, and then escaping backslashes mangles the
    // escape that was just written. `\(` must be exactly `\5c\28`.
    expect(escapeFilterValue("\\(")).toBe("\\5c\\28");
    expect(escapeFilterValue("\\*")).toBe("\\5c\\2a");
  });

  test("an ordinary value is unchanged", () => {
    // Escaping that mangles normal input gets removed by the next person who
    // hits a false rejection.
    expect(escapeFilterValue("alice")).toBe("alice");
    expect(escapeFilterValue("alice@example.com")).toBe("alice@example.com");
    expect(escapeFilterValue("O'Brien-Smith.jr")).toBe("O'Brien-Smith.jr");
  });

  test("the classic injection payload is neutralized", () => {
    const escaped = escapeFilterValue("alice)(uid=*");
    expect(escaped).not.toContain(")");
    expect(escaped).not.toContain("(");
    expect(escaped).not.toContain("*");
  });

  test("non-string input does not silently become a filter fragment", () => {
    // A JSON body can carry a number, an object, or an array where a username
    // was expected. `String(value)` on an object gives "[object Object]", which
    // is harmless — but `null` and `undefined` must not become the text "null".
    expect(escapeFilterValue(null)).toBe("");
    expect(escapeFilterValue(undefined)).toBe("");
    expect(escapeFilterValue(123)).toBe("123");
  });
});

describe("escapeDn — RFC 4514", () => {
  test("DN special characters are escaped", () => {
    // A DN goes into a bind, not a filter, and has a different special set.
    for (const character of [",", "+", '"', "\\", "<", ">", ";"])
      expect(escapeDn(character)).toBe(`\\${character}`);
  });

  test("leading and trailing spaces and a leading # are escaped", () => {
    expect(escapeDn(" alice")).toBe("\\ alice");
    expect(escapeDn("alice ")).toBe("alice\\ ");
    expect(escapeDn("#alice")).toBe("\\#alice");
  });

  test("NUL becomes its hex escape, not a literal", () => {
    // A raw NUL truncates the DN at whatever C library eventually parses it, so
    // the bind targets a shorter — different — DN than the one intended, with
    // nothing in the logs to say so.
    expect(escapeDn("a\0b")).toBe("a\\00b");
  });

  test("an ordinary DN component is unchanged", () => {
    expect(escapeDn("alice")).toBe("alice");
  });
});

describe("escaping actually stops the injection against the real fixture", () => {
  // The point of the module, proved end to end rather than by inspection — and
  // against the filter shape a driver ACTUALLY writes, an `&` carrying the
  // object class. Techlead's FAIL on da87ec42 was that these ran against a lone
  // `(uid=…)`, which is not what the code produces, so the injection that
  // matters was never exercised.

  test("a CONCATENATED base filter matches more than one person", async () => {
    const directory = await readyDirectory();
    const attacker = "*)(uid=*";
    // What a driver written the obvious way produces: the payload closes the uid
    // assertion and adds a third clause inside the existing `&`.
    const results = await directory.search(DEFAULT_BASE_DN, baseFilter(attacker));
    expect(results.length).toBeGreaterThan(1);
  });

  test("an ESCAPED value in the same filter matches nobody", async () => {
    const directory = await readyDirectory();
    const attacker = "*)(uid=*";
    const results = await directory.search(
      DEFAULT_BASE_DN,
      baseFilter(escapeFilterValue(attacker))
    );
    // Nobody has that literal uid, so the correct answer is zero — not "alice",
    // and certainly not everyone.
    expect(results).toHaveLength(0);
  });

  test("an escaped ORDINARY username still finds its person", async () => {
    // Escaping that broke normal logins would be removed within a week.
    const directory = await readyDirectory();
    const results = await directory.search(
      DEFAULT_BASE_DN,
      baseFilter(escapeFilterValue("alice"))
    );
    expect(results).toHaveLength(1);
    expect(results[0].dn).toBe(`uid=alice,${DEFAULT_BASE_DN}`);
  });

  test("an escaped value containing REAL metacharacters still matches", async () => {
    // `o(dd)*ball@example.com` is a legitimate address. Escaping must preserve
    // it: a driver that could not find this person would look broken to an
    // operator, who would then remove the escaping — which is how a security
    // control dies of a false positive.
    const directory = await readyDirectory();
    const results = await directory.search(
      DEFAULT_BASE_DN,
      `(&(objectClass=${PERSON_CLASS})(mail=${escapeFilterValue(
        "o(dd)*ball@example.com"
      )}))`
    );
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("oddball");
  });
});
