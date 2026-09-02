// S3 (#60) — LdapIdentityProvider, against the fixtures written first.
//
// RED-first: written before the driver exists.
//
// The driver AUTHENTICATES and NORMALIZES; it never creates a user, issues a
// session or assigns a role (seam 01 §Boundaries). Unlike S1 and S2 it briefly
// holds the user's directory password, which is the single new risk in S3 and
// is why several tests below are about what the driver does NOT do with it.
//
// PMO ruling 1 shapes the whole flow: bind a service account, search for exactly
// one entry, then bind the DN the SEARCH returned using the user's password.

const {
  makeDirectory,
  SERVICE_DN,
  SERVICE_PASSWORD,
  DEFAULT_BASE_DN,
} = require("../../../__testHelpers__/ldap/directory");
const {
  LdapIdentityProvider,
} = require("../../../utils/identityProviders/LdapIdentityProvider");
const {
  IdentityAuthenticationError,
  IdentityConfigurationError,
  IdentityUnavailableError,
  IdentityCapabilityError,
} = require("../../../utils/identityProviders/errors");

/** A driver wired to a fresh mock directory. */
function driver(overrides = {}, directoryOptions = {}) {
  const directory = makeDirectory(directoryOptions);
  const instance = new LdapIdentityProvider({
    url: "ldaps://directory.example.com:636",
    baseDn: DEFAULT_BASE_DN,
    bindDn: SERVICE_DN,
    bindPassword: SERVICE_PASSWORD,
    usernameAttribute: "uid",
    emailAttribute: "mail",
    displayNameAttribute: "cn",
    // The mock stands in for a real connection; the driver must not care which.
    connect: async () => directory,
    ...overrides,
  });
  return { instance, directory };
}

const login = (instance, username, password) =>
  instance.completeLogin({ username, password });

describe("configuration", () => {
  test("providerId is ldap and capabilities are honest", () => {
    expect(LdapIdentityProvider.providerId()).toBe("ldap");
    const capabilities = LdapIdentityProvider.capabilities();
    // Ruling 2: there is no redirect to begin.
    expect(capabilities.redirect).toBe(false);
    expect(capabilities.password).toBe(true);
    // Ruling 5: directory sync is S4's. Claiming it here would be a lie core
    // acts on — LDAP *could* do it, which is exactly why the flag must be false
    // until the code honours it.
    expect(capabilities.directorySync).toBe(false);
    expect(capabilities.groupSync).toBe(false);
  });

  test("a driver with no bind credentials refuses to be built", () => {
    // Fail closed: a missing service account must not silently become an
    // anonymous search, which returns whatever the directory shows the world.
    expect(() => driver({ bindDn: null })).toThrow(IdentityConfigurationError);
    expect(() => driver({ bindPassword: null })).toThrow(IdentityConfigurationError);
  });

  test("a driver with no baseDn refuses to be built", () => {
    expect(() => driver({ baseDn: "" })).toThrow(IdentityConfigurationError);
  });

  test("beginLogin is a capability error — there is no redirect", () => {
    // Ruling 2. Returning a URL would make the route layer invent a flow that
    // does not exist for this protocol.
    const { instance } = driver();
    expect(() => instance.beginLogin({ stateToken: "x" })).toThrow(
      IdentityCapabilityError
    );
  });
});

describe("the happy path", () => {
  test("correct credentials yield a normalized principal", async () => {
    // Without this every refusal below would prove nothing: a driver that
    // refuses everything is broken, not secure.
    const { instance } = driver();
    const principal = await login(instance, "alice", "alice-correct-password");

    expect(principal.provider).toBe("ldap");
    expect(principal.email).toBe("alice@example.com");
    expect(principal.displayName).toBe("Alice Smith");
    // The DN is the subject: it survives a rename of uid or mail, which is what
    // makes a returning user the same person.
    expect(principal.subject).toBe(`uid=alice,${DEFAULT_BASE_DN}`);
    // The directory asserting an address IS the verification here.
    expect(principal.emailVerified).toBe(true);
  });

  test("the service account binds BEFORE the search", async () => {
    const { instance, directory } = driver();
    await login(instance, "alice", "alice-correct-password");

    // Ruling 1's order, asserted on the calls actually made rather than read
    // from the source.
    expect(directory.calls.binds[0].dn).toBe(SERVICE_DN);
    expect(directory.calls.searches).toHaveLength(1);
    // And the user's own bind comes after.
    expect(directory.calls.binds[1].dn).toBe(`uid=alice,${DEFAULT_BASE_DN}`);
  });

  test("the DN bound is the one the SEARCH returned, never the user's input", async () => {
    // A driver that assembles `uid=${input},${baseDn}` binds a string the
    // attacker controls. It also breaks for any directory whose DNs are not
    // shaped that way, which is most of them.
    const { instance, directory } = driver();
    await login(instance, "alice", "alice-correct-password");

    const userBind = directory.calls.binds[1];
    expect(userBind.dn).toBe(`uid=alice,${DEFAULT_BASE_DN}`);
    expect(directory.people.some((p) => p.dn === userBind.dn)).toBe(true);
  });
});

describe("the empty-password bind — RFC 4513's trap", () => {
  test("an empty password is refused BEFORE anything is sent to the server", async () => {
    // Ruling: refused before the bind. The mock would ACCEPT this as an
    // anonymous bind, so a driver that forwarded it and read "no exception" as
    // success would log this person in as alice.
    const { instance, directory } = driver();
    await expect(login(instance, "alice", "")).rejects.toThrow(
      IdentityAuthenticationError
    );

    // The credential never reached the directory at all.
    const userBinds = directory.calls.binds.filter((call) => call.dn !== SERVICE_DN);
    expect(userBinds).toHaveLength(0);
  });

  test("null, undefined and whitespace-only passwords are refused the same way", async () => {
    // A form field that was never filled in, a JSON body missing the key, and a
    // user who typed three spaces must not be three different code paths.
    const { instance, directory } = driver();
    for (const password of [null, undefined, "   ", "\t"]) {
      await expect(login(instance, "alice", password)).rejects.toThrow(
        IdentityAuthenticationError
      );
    }
    const userBinds = directory.calls.binds.filter((call) => call.dn !== SERVICE_DN);
    expect(userBinds).toHaveLength(0);
  });

  test("an anonymous bind result is NOT treated as authentication", async () => {
    // Belt and braces for the case where a server accepts something we did not
    // anticipate: the driver must read the authenticated flag, not the absence
    // of an exception.
    const { instance } = driver({}, { allowAnonymous: true });
    await expect(login(instance, "alice", " ")).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("a server that answers EVERY bind anonymously authenticates nobody", async () => {
    // The second line of defence, tested on its own.
    //
    // The empty-password guard above cannot cover this: the password here is a
    // perfectly ordinary non-empty string, and the server still resolves the
    // bind as anonymous without throwing. Only reading `authenticated` catches
    // it — and a mutation run proved that check was otherwise unverified,
    // because the first guard was quietly covering for it in every other test.
    const { instance } = driver({}, { alwaysAnonymous: true });
    await expect(
      login(instance, "alice", "alice-correct-password")
    ).rejects.toThrow(IdentityAuthenticationError);
  });
});

describe("LDAP injection", () => {
  test("an injection payload authenticates nobody", async () => {
    const { instance } = driver();
    await expect(
      login(instance, "alice)(uid=*", "alice-correct-password")
    ).rejects.toThrow(IdentityAuthenticationError);
  });

  test("the filter SENT to the directory is escaped", async () => {
    // Asserted on the wire, not on the outcome: a driver could refuse this login
    // for an unrelated reason while still sending an injectable filter that
    // matters on some other input.
    const { instance, directory } = driver();
    await login(instance, "alice)(uid=*", "whatever").catch(() => null);

    const [search] = directory.calls.searches;
    expect(search.filter).not.toContain("alice)(uid=*");
    expect(search.filter).toContain("\\29\\28");
  });

  test("a wildcard username matches nobody rather than everybody", async () => {
    const { instance } = driver();
    await expect(login(instance, "*", "alice-correct-password")).rejects.toThrow(
      IdentityAuthenticationError
    );
  });
});

describe("search results", () => {
  test("MULTIPLE matches are refused — never 'take the first'", async () => {
    // The LDAP spelling of S2's XSW document-order bug: choosing between two
    // entries is choosing who to log in as, and the attacker picks the input.
    const { instance } = driver({ baseDn: "dc=example,dc=com" });
    await expect(login(instance, "duplicate", "dup-one-password")).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("a multiple-match refusal binds nobody", async () => {
    const { instance, directory } = driver({ baseDn: "dc=example,dc=com" });
    await login(instance, "duplicate", "dup-one-password").catch(() => null);
    const userBinds = directory.calls.binds.filter((call) => call.dn !== SERVICE_DN);
    expect(userBinds).toHaveLength(0);
  });

  test("ZERO matches and a WRONG password fail identically", async () => {
    // No user-enumeration oracle: "that account does not exist" tells an
    // attacker which usernames are worth attacking.
    const { instance } = driver();
    const missing = await login(instance, "nobody", "any-password").catch((e) => e);
    const wrong = await login(instance, "alice", "wrong-password").catch((e) => e);

    expect(missing.constructor).toBe(wrong.constructor);
    expect(missing.message).toBe(wrong.message);
  });

  test("an entry missing its email attribute is refused, not defaulted", async () => {
    // linkPrincipal keys on email. Inventing one — from the uid, say — would
    // create an account under an address the person may not own.
    const { instance } = driver({ emailAttribute: "nonexistent" });
    await expect(login(instance, "alice", "alice-correct-password")).rejects.toThrow(
      IdentityAuthenticationError
    );
  });
});

describe("the service bind is not optional", () => {
  test("a driver that never bound the service account cannot search", async () => {
    // Techlead ruling 3: anonymous read is disabled on the fixture, as on any
    // hardened directory. This asserts the driver DOES bind — if it skipped that
    // step it would get insufficientAccess and every login would fail, which is
    // a failure mode worth pinning rather than discovering in production.
    const { instance, directory } = driver();
    await login(instance, "alice", "alice-correct-password");
    expect(directory.calls.binds[0].dn).toBe(SERVICE_DN);
    expect(directory.boundAuthenticated).toBe(false); // unbound in `finally`
  });

  test("a WRONG service password is UNAVAILABLE, not a user-facing refusal", async () => {
    // A broken service account is our configuration problem. Reporting it as
    // "invalid credentials" would tell every user their password is wrong and
    // send the operator hunting in the wrong place.
    const { instance } = driver({ bindPassword: "wrong-service-password" });
    const error = await login(instance, "alice", "alice-correct-password").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityUnavailableError);
  });

  test("an UNAUTHENTICATED service bind does not become an anonymous search", async () => {
    // RFC 4513 §5.1.2 again, one layer up: binding the service DN with an empty
    // password "succeeds" while authenticating nobody. A driver that read that
    // as success would search anonymously believing it was authenticated.
    const { instance } = driver({ bindPassword: "   " });
    await expect(login(instance, "alice", "alice-correct-password")).rejects.toThrow();
  });

  test("a service bind that resolves ANONYMOUSLY without throwing is refused", async () => {
    // §7.9c, second instance. The `serviceBind.authenticated !== true` check was
    // a mutation SURVIVOR: every case that could reach it threw instead, and a
    // thrown error is caught one layer up and reclassified — so the flag check
    // was shadowed and never actually exercised.
    //
    // This is the input that reaches it: a directory resolving the service bind
    // anonymously with a perfectly ordinary password and no exception at all.
    // Nothing but the flag distinguishes it, and searching in that state means
    // searching as nobody while believing we authenticated.
    const { instance } = driver({}, { serviceBindAnonymous: true });
    const error = await login(instance, "alice", "alice-correct-password").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityUnavailableError);
  });
});

describe("DN case", () => {
  test("the DN from the search is bound verbatim, whatever its case", async () => {
    // `Alice.Smith`'s entry stores its DN in a different case from the base.
    // A driver assembling `uid=${input},${baseDn}` would build a DN that does
    // not match, or would match the wrong person.
    const { instance, directory } = driver({ baseDn: "dc=example,dc=com" });
    const principal = await login(
      instance,
      "Alice.Smith",
      "alice-smith-password"
    );

    expect(principal.subject).toBe("UID=Alice.Smith,OU=People,DC=Example,DC=com");
    expect(principal.email).toBe("alice.smith@example.com");
    const userBind = directory.calls.binds[1];
    expect(userBind.dn).toBe("UID=Alice.Smith,OU=People,DC=Example,DC=com");
  });

  test("two differently-cased entries stay two different people", async () => {
    // `alice` and `Alice.Smith` are separate accounts with separate mailboxes.
    // Collapsing them — by lowercasing the DN, say — would let one log in as
    // the other.
    const { instance } = driver({ baseDn: "dc=example,dc=com" });
    const first = await login(instance, "alice", "alice-correct-password");
    const second = await login(instance, "Alice.Smith", "alice-smith-password");
    expect(first.subject).not.toBe(second.subject);
    expect(first.email).not.toBe(second.email);
  });
});

describe("StartTLS", () => {
  test("StartTLS is negotiated when configured, before any bind", async () => {
    // The whole point of StartTLS is that it happens FIRST. Negotiating after
    // the service bind would send that credential in the clear, and after the
    // user bind would send theirs.
    const directory = makeDirectory({ tls: false });
    const instance = new LdapIdentityProvider({
      url: "ldap://directory.example.com:389",
      baseDn: DEFAULT_BASE_DN,
      bindDn: SERVICE_DN,
      bindPassword: SERVICE_PASSWORD,
      startTls: true,
      connect: async () => {
        await directory.startTLS();
        return directory;
      },
    });

    await login(instance, "alice", "alice-correct-password");
    expect(directory.calls.startTls).toBe(1);
    // Every bind happened on an encrypted connection.
    for (const call of directory.calls.binds) expect(call.tls).toBe(true);
  });

  test("a FAILED StartTLS aborts the login — never a plaintext fallback", async () => {
    // The downgrade the requirement exists to prevent. Continuing here would
    // send the user's directory password in cleartext, and the login would
    // SUCCEED, so nothing would look wrong from either end.
    const directory = makeDirectory({ tls: false, startTlsFails: true });
    const instance = new LdapIdentityProvider({
      url: "ldap://directory.example.com:389",
      baseDn: DEFAULT_BASE_DN,
      bindDn: SERVICE_DN,
      bindPassword: SERVICE_PASSWORD,
      startTls: true,
      connect: async () => {
        await directory.startTLS();
        return directory;
      },
    });

    await expect(login(instance, "alice", "alice-correct-password")).rejects.toThrow();
    // And nothing was sent over the plaintext connection afterwards.
    expect(directory.calls.binds).toHaveLength(0);
  });
});

describe("transport", () => {
  test("a referral is refused, never followed", async () => {
    // Following one means authentication is answered by a host nobody chose.
    const { instance } = driver({}, { referral: "ldap://attacker.example.com" });
    await expect(login(instance, "alice", "alice-correct-password")).rejects.toThrow(
      IdentityAuthenticationError
    );
  });

  test("a directory that is unreachable is UNAVAILABLE (retryable), not a refusal", async () => {
    // Only IdentityUnavailableError is retryable in the seam. Reporting an
    // outage as bad credentials tells a user their password is wrong when it is
    // not; reporting bad credentials as an outage invites automatic retries
    // that lock the account.
    const { instance } = driver({
      connect: async () => {
        throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
    });
    const error = await login(instance, "alice", "alice-correct-password").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(IdentityUnavailableError);
    expect(error.retryable).toBe(true);
  });

  test("a WRONG password is not retryable", async () => {
    const { instance } = driver();
    const error = await login(instance, "alice", "wrong-password").catch((e) => e);
    expect(error).toBeInstanceOf(IdentityAuthenticationError);
    expect(error.retryable).toBe(false);
  });
});

describe("the password is not kept", () => {
  test("it never appears in the returned principal", async () => {
    // The principal is logged, audited and passed to core. A password reaching
    // any of those is a password in a place nobody thinks to look for one.
    const { instance } = driver();
    const principal = await login(instance, "alice", "alice-correct-password");
    expect(JSON.stringify(principal)).not.toContain("alice-correct-password");
  });

  test("it never appears in an error message", async () => {
    const { instance } = driver();
    const error = await login(instance, "alice", "hunter2-wrong").catch((e) => e);
    expect(error.message).not.toContain("hunter2-wrong");
    // Nor the username, which would make the refusal an enumeration signal in
    // any log an operator pastes into a ticket.
    expect(error.message).not.toContain("alice");
  });
});

describe("boundaries (seam 01)", () => {
  test("directory sync is not supported", async () => {
    const { instance } = driver();
    await expect(instance.listPrincipals()).rejects.toThrow(IdentityCapabilityError);
    await expect(instance.listGroups()).rejects.toThrow(IdentityCapabilityError);
  });

  test("completeLogin returns a principal — it never creates a user", async () => {
    const { instance } = driver();
    const principal = await login(instance, "alice", "alice-correct-password");
    // No id, no role, no token: those are linkPrincipal's and the route's.
    expect(principal.id).toBeUndefined();
    expect(principal.role).toBeUndefined();
    expect(principal.token).toBeUndefined();
  });
});
