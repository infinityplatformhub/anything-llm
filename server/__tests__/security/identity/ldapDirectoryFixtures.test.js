// S3 (#60) — the mock directory is itself under test, BEFORE any driver exists.
//
// This file asserts that the fixtures reproduce the dangerous behaviours they
// are supposed to reproduce. Without it, the LDAP driver's tests could all pass
// against a mock that is simply too polite to expose a bypass — which is the
// #43 lesson (commit 01888688) in its LDAP form: two XSW fixtures there planted
// elements the driver's read path could never reach, so they went green against
// a deliberately unsafe verifier and proved nothing.
//
// A mock that refuses an empty password is not a strict mock. It is a broken
// one, and every driver test written against it would be worthless.

const {
  makeDirectory,
  parseFilter,
  LdapError,
  CODES,
  DEFAULT_BASE_DN,
  SERVICE_DN,
  SERVICE_PASSWORD,
  PERSON_CLASS,
} = require("../../../__testHelpers__/ldap/directory");

const aliceDn = `uid=alice,${DEFAULT_BASE_DN}`;

/** A directory with the service account already bound, ready to search. */
async function readyDirectory(options = {}) {
  const directory = makeDirectory(options);
  await directory.bind(SERVICE_DN, SERVICE_PASSWORD);
  return directory;
}

/** The base filter a real driver writes, with `value` as the username. */
const baseFilter = (value) => `(&(objectClass=${PERSON_CLASS})(${"uid"}=${value}))`;

describe("the mock reproduces RFC 4513's unauthenticated bind", () => {
  test("an EMPTY password bind SUCCEEDS — this is the trap, not a bug", async () => {
    const directory = makeDirectory();
    const result = await directory.bind(aliceDn, "");

    // The call resolves. A driver reading "no exception" as "password correct"
    // logs in anyone who submits a blank password, against any DN it can name.
    expect(result.anonymous).toBe(true);
    // And the flag that tells them apart is here, unignorable.
    expect(result.authenticated).toBe(false);
  });

  test("null and undefined passwords behave the same way", async () => {
    // A form submitting no field at all, or a JSON body with a missing key,
    // must not be a different code path from an empty string.
    const directory = makeDirectory();
    for (const password of [null, undefined]) {
      const result = await directory.bind(aliceDn, password);
      expect(result.authenticated).toBe(false);
    }
  });

  test("a CORRECT password is distinguishable from the anonymous case", async () => {
    // The counterweight. If this failed, a driver could pass every negative test
    // by refusing everything, which is broken rather than secure.
    const directory = makeDirectory();
    const result = await directory.bind(aliceDn, "alice-correct-password");
    expect(result.authenticated).toBe(true);
    expect(result.anonymous).toBe(false);
  });

  test("a WRONG password throws invalidCredentials", async () => {
    const directory = makeDirectory();
    const error = await directory.bind(aliceDn, "not-the-password").catch((e) => e);
    expect(error).toBeInstanceOf(LdapError);
    expect(error.code).toBe(CODES.invalidCredentials);
  });

  test("a directory that forbids UNAUTHENTICATED binds refuses the empty password", async () => {
    // Some servers are hardened this way. A driver must not DEPEND on it: the
    // deployment's directory is not ours to configure.
    //
    // The flag is `allowUnauthenticated`, not `allowAnonymous` — this is a DN
    // with an empty password (§5.1.2), and the two are separate settings on a
    // real server. Conflating them, as this test did before Techlead ruling 4,
    // means one of the two goes untested.
    const directory = makeDirectory({ allowUnauthenticated: false });
    const error = await directory.bind(aliceDn, "").catch((e) => e);
    expect(error).toBeInstanceOf(LdapError);
  });
});

describe("the mock is genuinely injectable — with a REALISTIC base filter", () => {
  // Techlead FAIL on da87ec42: the previous matcher special-cased a leading
  // `(|` and otherwise required every clause, so it never parsed `&`. That is
  // the operator every real base filter uses, which meant the injection that
  // actually matters went untested and a concatenating driver looked safe.

  test("the honest base filter matches exactly one person", async () => {
    const directory = await readyDirectory();
    const results = await directory.search(DEFAULT_BASE_DN, baseFilter("alice"));
    expect(results).toHaveLength(1);
    expect(results[0].dn).toBe(aliceDn);
  });

  test("an injected payload inside an `&` filter matches EVERYONE", async () => {
    // This is the shape a naive driver really produces. The payload `*)(uid=*`
    // interpolated into `(&(objectClass=…)(uid=${input}))` closes the uid
    // assertion and adds a third clause INSIDE the existing `&`:
    //
    //   (&(objectClass=inetOrgPerson)(uid=*)(uid=*))
    //
    // Every clause is true for every person, so one login query becomes the
    // whole directory. If the mock cannot parse `&`, this returns 1 and the
    // fixture proves nothing.
    const directory = await readyDirectory();
    const honest = await directory.search(DEFAULT_BASE_DN, baseFilter("alice"));
    const injected = await directory.search(DEFAULT_BASE_DN, baseFilter("*)(uid=*"));

    expect(honest).toHaveLength(1);
    expect(injected.length).toBeGreaterThan(honest.length);
    // Not merely "more": everyone under the base.
    expect(injected.length).toBeGreaterThanOrEqual(4);
  });

  test("an ESCAPED payload in the same filter matches nobody", async () => {
    // The fix, in the same shape as the attack.
    const directory = await readyDirectory();
    const escaped = baseFilter("\\2a\\29\\28uid=\\2a");
    expect(await directory.search(DEFAULT_BASE_DN, escaped)).toHaveLength(0);
  });

  test("the parser really parses — `&`, `|`, `!` and nesting", () => {
    // Guarding the guard: if `parseFilter` silently returned null for these, the
    // search tests above would fail for the wrong reason and the mock would be
    // untrustworthy in a way that looks like strictness.
    expect(parseFilter("(uid=alice)")).toMatchObject({ type: "=", attribute: "uid" });
    expect(parseFilter("(&(a=1)(b=2))")).toMatchObject({ type: "&" });
    expect(parseFilter("(|(a=1)(b=2))")).toMatchObject({ type: "|" });
    expect(parseFilter("(!(a=1))")).toMatchObject({ type: "!" });
    expect(parseFilter("(&(a=1)(|(b=2)(c=3)))")).toMatchObject({ type: "&" });
    // Malformed input is null, not a filter that quietly matches nothing.
    expect(parseFilter("(uid=alice")).toBeNull();
    expect(parseFilter("(&)")).toBeNull();
    expect(parseFilter("(uid=alice))")).toBeNull();
  });

  test("a `!` clause is honoured, not ignored", async () => {
    // A parser that dropped negation would make an excluding filter match
    // everyone — the opposite of what it says.
    const directory = await readyDirectory();
    const results = await directory.search(
      DEFAULT_BASE_DN,
      `(&(objectClass=${PERSON_CLASS})(!(uid=alice)))`
    );
    expect(results.every((entry) => entry.uid !== "alice")).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  test("a wildcard in a value matches more than one person", async () => {
    const directory = await readyDirectory();
    const results = await directory.search(DEFAULT_BASE_DN, "(uid=*)");
    expect(results.length).toBeGreaterThan(1);
  });

  test("escaping PRESERVES a legitimate value containing filter metacharacters", async () => {
    // QA-1 NIT: `O(dd) *Ball` is a real name, and `o(dd)*ball@example.com` a
    // real address. Escaping that dropped or mangled those characters would fail
    // to find this person, and an operator would reasonably conclude escaping
    // was the problem and remove it.
    const directory = await readyDirectory();
    const results = await directory.search(
      DEFAULT_BASE_DN,
      "(mail=o\\28dd\\29\\2aball@example.com)"
    );
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("oddball");
  });
});

describe("anonymous read is disabled", () => {
  test("a search BEFORE the service bind is refused", async () => {
    // Techlead ruling 3. A driver that skipped or swallowed the service bind
    // would otherwise fall back to whatever the directory shows the world —
    // usually a smaller set, so the failure looks like "user not found" rather
    // than like a missing credential.
    const directory = makeDirectory();
    const error = await directory
      .search(DEFAULT_BASE_DN, baseFilter("alice"))
      .catch((e) => e);
    expect(error).toBeInstanceOf(LdapError);
    expect(error.code).toBe(CODES.insufficientAccess);
  });

  test("a search after an UNAUTHENTICATED service bind is refused", async () => {
    // Ruling 4's follow-on: binding the service DN with an empty password
    // "succeeds", but authenticates nobody — so the search must still fail. A
    // driver that treated that bind as success would search anonymously while
    // believing it had authenticated.
    const directory = makeDirectory();
    const result = await directory.bind(SERVICE_DN, "");
    expect(result.authenticated).toBe(false);
    expect(result.unauthenticated).toBe(true);

    const error = await directory
      .search(DEFAULT_BASE_DN, baseFilter("alice"))
      .catch((e) => e);
    expect(error.code).toBe(CODES.insufficientAccess);
  });

  test("a search after a SUCCESSFUL service bind works", async () => {
    // The counterweight: a mock that refused every search would make the tests
    // above pass while proving nothing.
    const directory = await readyDirectory();
    expect(
      await directory.search(DEFAULT_BASE_DN, baseFilter("alice"))
    ).toHaveLength(1);
  });

  test("unbinding drops the authenticated state", async () => {
    const directory = await readyDirectory();
    await directory.unbind();
    await expect(
      directory.search(DEFAULT_BASE_DN, baseFilter("alice"))
    ).rejects.toThrow(LdapError);
  });
});

describe("RFC 4513 distinguishes anonymous from unauthenticated", () => {
  test("§5.1.1 anonymous: empty DN and empty password", async () => {
    const directory = makeDirectory();
    const result = await directory.bind("", "");
    expect(result.authenticated).toBe(false);
    expect(result.anonymous).toBe(true);
    expect(result.unauthenticated).toBe(false);
  });

  test("§5.1.2 unauthenticated: a DN with an empty password", async () => {
    // Two different operations with the same trap, and a driver can get one
    // right while getting the other wrong — which is why they are separate
    // flags and separate tests.
    const directory = makeDirectory();
    const result = await directory.bind(aliceDn, "");
    expect(result.authenticated).toBe(false);
    expect(result.unauthenticated).toBe(true);
  });

  test("a server with unauthenticated binds disabled refuses the DN case", async () => {
    const directory = makeDirectory({ allowUnauthenticated: false });
    await expect(directory.bind(aliceDn, "")).rejects.toThrow(LdapError);
  });

  test("a server with anonymous binds disabled refuses the empty-DN case", async () => {
    const directory = makeDirectory({ allowAnonymous: false });
    await expect(directory.bind("", "")).rejects.toThrow(LdapError);
  });
});

describe("DNs are case-insensitive, as on a real server", () => {
  test("a DN in different case binds the same person", async () => {
    // QA-1 G3. Without this the mock rejects a DN it had just handed out from a
    // search, and the DN-case trap below could not be tested at all.
    const directory = makeDirectory();
    const result = await directory.bind(
      "UID=ALICE,OU=PEOPLE,DC=EXAMPLE,DC=COM",
      "alice-correct-password"
    );
    expect(result.authenticated).toBe(true);
  });

  test("the directory holds a differently-cased DN for another person", async () => {
    // `Alice.Smith` is a SEPARATE entry whose DN is written in another case. A
    // driver that built a DN from input rather than using the search result
    // would either miss them or bind the wrong one.
    const directory = await readyDirectory();
    const results = await directory.search("dc=example,dc=com", "(uid=Alice.Smith)");
    expect(results).toHaveLength(1);
    expect(results[0].dn).toBe("UID=Alice.Smith,OU=People,DC=Example,DC=com");
    expect(results[0].mail).toBe("alice.smith@example.com");
  });
});

describe("the mock returns more than one entry when a filter is loose", () => {
  test("two people share a uid across branches", async () => {
    // "Take the first result" is the LDAP spelling of S2's XSW document-order
    // bug: the code picks between two candidates and the attacker picks which.
    const directory = await readyDirectory();
    const results = await directory.search("dc=example,dc=com", "(uid=duplicate)");
    expect(results).toHaveLength(2);
    expect(results[0].dn).not.toBe(results[1].dn);
  });

  test("a search for nobody returns an empty list, not an error", async () => {
    // It must be an ordinary empty result: if "no such user" threw something
    // distinctive, the route above it would leak which usernames exist.
    const directory = await readyDirectory();
    expect(await directory.search(DEFAULT_BASE_DN, "(uid=nobody)")).toEqual([]);
  });

  test("search results never carry the password attribute", async () => {
    const directory = await readyDirectory();
    const [entry] = await directory.search(DEFAULT_BASE_DN, "(uid=alice)");
    expect(entry.password).toBeUndefined();
    expect(entry.dn).toBe(aliceDn);
  });

  test("the DN in a result is authoritative — it is not the caller's input", async () => {
    // The same person searched by mail still comes back under their real DN, so
    // a driver has no excuse to bind the string a user typed.
    const directory = await readyDirectory();
    const [entry] = await directory.search(DEFAULT_BASE_DN, "(mail=alice@example.com)");
    expect(entry.dn).toBe(aliceDn);
  });
});

describe("the mock enforces transport and referral behaviour", () => {
  test("a bind over an unencrypted connection is refused by the server", async () => {
    // Even when the driver is willing, a correctly configured directory says no.
    // The driver must not rely on that: the deployment's server is not ours.
    const directory = makeDirectory({ tls: false });
    const error = await directory
      .bind(aliceDn, "alice-correct-password")
      .catch((e) => e);
    expect(error.code).toBe(CODES.confidentialityRequired);
  });

  test("a FAILED StartTLS leaves the connection unusable — never plaintext", async () => {
    const directory = makeDirectory({ tls: false, startTlsFails: true });
    await expect(directory.startTls()).rejects.toThrow(LdapError);

    // The downgrade this exists to prevent: carrying on after a failed StartTLS
    // sends the user's password in the clear.
    expect(directory.tlsActive).toBe(false);
    const error = await directory
      .bind(aliceDn, "alice-correct-password")
      .catch((e) => e);
    expect(error.code).toBe(CODES.confidentialityRequired);
  });

  test("a successful StartTLS makes the connection usable", async () => {
    const directory = makeDirectory({ tls: false });
    await directory.startTls();
    expect(directory.tlsActive).toBe(true);
    await expect(
      directory.bind(aliceDn, "alice-correct-password")
    ).resolves.toMatchObject({ authenticated: true });
  });

  test("QA-1 G1: a SEARCH after a failed StartTLS is refused too", async () => {
    // The transport requirement covers every operation, not just the bind.
    // Otherwise a driver could be caught sending the password in the clear while
    // still happily reading the directory over the same plaintext connection —
    // and a test that only checked bind would call that safe.
    const directory = makeDirectory({ tls: false, startTlsFails: true });
    await expect(directory.startTls()).rejects.toThrow(LdapError);

    const error = await directory
      .search(DEFAULT_BASE_DN, baseFilter("alice"))
      .catch((e) => e);
    expect(error.code).toBe(CODES.confidentialityRequired);
  });

  test("a referral on SEARCH is an error, never a redirect to follow", async () => {
    // Following one means authentication is answered by a host nobody chose.
    const directory = await readyDirectory();
    const referring = makeDirectory({ referral: "ldap://attacker.example.com" });
    // The service bind on `referring` refers as well (see below), so this asserts
    // the search path specifically against an already-bound directory.
    expect(directory).toBeDefined();
    const error = await referring
      .bind(SERVICE_DN, SERVICE_PASSWORD)
      .catch((e) => e);
    expect(error.code).toBe(CODES.referral);
  });

  test("QA-1 G2: a referral on BIND is an error too", async () => {
    // A real server can refer on a bind, not only on a search. A driver that
    // handled referrals on one operation and not the other has a hole on
    // whichever it forgot — and bind is the one that authenticates.
    const directory = makeDirectory({ referral: "ldap://attacker.example.com" });
    const error = await directory
      .bind(aliceDn, "alice-correct-password")
      .catch((e) => e);
    expect(error).toBeInstanceOf(LdapError);
    expect(error.code).toBe(CODES.referral);
  });
});

describe("the service account is a real credential", () => {
  test("the service DN binds with its own password", async () => {
    const directory = makeDirectory();
    await expect(directory.bind(SERVICE_DN, SERVICE_PASSWORD)).resolves.toMatchObject(
      { authenticated: true }
    );
  });

  test("the service DN with a wrong password is refused", async () => {
    // Otherwise a driver could "successfully" bind a misconfigured service
    // account and search on, which would make a broken deployment look healthy.
    const directory = makeDirectory();
    await expect(directory.bind(SERVICE_DN, "wrong")).rejects.toThrow(LdapError);
  });
});
