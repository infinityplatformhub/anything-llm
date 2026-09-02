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
  LdapError,
  CODES,
  DEFAULT_BASE_DN,
  SERVICE_DN,
  SERVICE_PASSWORD,
} = require("../../../__testHelpers__/ldap/directory");

const aliceDn = `uid=alice,${DEFAULT_BASE_DN}`;

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

  test("a directory configured to forbid anonymous binds refuses the empty password", async () => {
    // Some servers are hardened this way. A driver must not DEPEND on that:
    // the deployment's directory is not ours to configure.
    const directory = makeDirectory({ allowAnonymous: false });
    const error = await directory.bind(aliceDn, "").catch((e) => e);
    expect(error).toBeInstanceOf(LdapError);
  });
});

describe("the mock is genuinely injectable", () => {
  test("a concatenated filter widens the match — the LDAP injection is real", async () => {
    const directory = makeDirectory();

    // What a driver building `(uid=${input})` produces when the input is
    // `alice)(uid=*`, wrapped in an OR the attacker supplies.
    const honest = await directory.search(DEFAULT_BASE_DN, "(uid=alice)");
    const injected = await directory.search(
      DEFAULT_BASE_DN,
      "(|(uid=alice)(uid=*))"
    );

    expect(honest).toHaveLength(1);
    // If this were 1, the fixture would prove nothing and an injectable driver
    // would look safe.
    expect(injected.length).toBeGreaterThan(honest.length);
  });

  test("a wildcard in a value matches more than one person", async () => {
    const directory = makeDirectory();
    const results = await directory.search(DEFAULT_BASE_DN, "(uid=*)");
    expect(results.length).toBeGreaterThan(1);
  });

  test("an ESCAPED filter does not widen — escaping is the fix, and it works", async () => {
    // RFC 4515: `(`, `)`, `*`, `\` and NUL are escaped in an assertion value.
    // The escaped form must match NOBODY, since no uid contains those literals.
    const directory = makeDirectory();
    const escaped = "(uid=alice\\29\\28uid=\\2a)";
    expect(await directory.search(DEFAULT_BASE_DN, escaped)).toHaveLength(0);
  });
});

describe("the mock returns more than one entry when a filter is loose", () => {
  test("two people share a uid across branches", async () => {
    // "Take the first result" is the LDAP spelling of S2's XSW document-order
    // bug: the code picks between two candidates and the attacker picks which.
    const directory = makeDirectory();
    const results = await directory.search("dc=example,dc=com", "(uid=duplicate)");
    expect(results).toHaveLength(2);
    expect(results[0].dn).not.toBe(results[1].dn);
  });

  test("a search for nobody returns an empty list, not an error", async () => {
    // It must be an ordinary empty result: if "no such user" threw something
    // distinctive, the route above it would leak which usernames exist.
    const directory = makeDirectory();
    expect(await directory.search(DEFAULT_BASE_DN, "(uid=nobody)")).toEqual([]);
  });

  test("search results never carry the password attribute", async () => {
    const directory = makeDirectory();
    const [entry] = await directory.search(DEFAULT_BASE_DN, "(uid=alice)");
    expect(entry.password).toBeUndefined();
    expect(entry.dn).toBe(aliceDn);
  });

  test("the DN in a result is authoritative — it is not the caller's input", async () => {
    // The same person searched by mail still comes back under their real DN, so
    // a driver has no excuse to bind the string a user typed.
    const directory = makeDirectory();
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

  test("a referral is an ERROR, never a redirect the driver may follow", async () => {
    // Following one means authentication is answered by a host nobody chose.
    const directory = makeDirectory({ referral: "ldap://attacker.example.com" });
    const error = await directory.search(DEFAULT_BASE_DN, "(uid=alice)").catch((e) => e);
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
