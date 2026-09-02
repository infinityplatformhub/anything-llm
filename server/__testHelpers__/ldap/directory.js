// S3 (#60): a mock LDAP directory — written BEFORE any library is chosen.
//
// Recon §5 / §7.9b make these the SELECTION CRITERION, the same way S2's XSW
// fixtures were: pick the client that fails them correctly, rather than picking
// one and validating it afterwards.
//
// The directory below is DELIBERATELY UNHELPFUL. A mock that politely rejects a
// bad password teaches nothing; real directory servers have behaviours that turn
// an obvious-looking driver into an authentication bypass, and those behaviours
// are what this file reproduces:
//
//   * RFC 4513 §5.1.2 — a bind with a DN and an EMPTY password succeeds as an
//     ANONYMOUS bind. A driver reading "bind did not throw" as "password
//     correct" admits anyone who submits a blank password. This is the single
//     most dangerous thing about LDAP authentication and it has burned real
//     products.
//   * An unauthenticated bind is the same trap with a different name.
//   * A search filter built by concatenation is injectable, exactly like SQL.
//   * A search can return MANY entries, and "take the first" is the LDAP
//     spelling of S2's XSW document-order bug.
//   * A server can answer with a REFERRAL — "ask that host instead" — which, if
//     followed, means authentication was answered by a server nobody chose.
//
// S2's lesson applies here too (#43, commit 01888688): a fixture must match the
// shape the code actually READS, not merely name the thing being guarded. A
// mock too eager to say no proves nothing about a driver that never asked.

const DEFAULT_BASE_DN = "ou=people,dc=example,dc=com";

/** The service account the driver binds as before searching (PMO ruling 1). */
const SERVICE_DN = "cn=svc-approof,ou=services,dc=example,dc=com";
const SERVICE_PASSWORD = "service-account-password";

/**
 * The people in the directory.
 *
 * `alice` and `Alice.Smith` differ only in DN case — the same person, and a
 * driver that keys on the input rather than on the DN the search returned would
 * make them two accounts.
 */
const PEOPLE = [
  {
    dn: `uid=alice,${DEFAULT_BASE_DN}`,
    uid: "alice",
    mail: "alice@example.com",
    cn: "Alice Smith",
    password: "alice-correct-password",
  },
  {
    dn: `uid=bob,${DEFAULT_BASE_DN}`,
    uid: "bob",
    mail: "bob@example.com",
    cn: "Bob Jones",
    password: "bob-correct-password",
  },
  // Two entries that a careless filter can match at once. The driver must refuse
  // rather than pick one: choosing between them is choosing who to log in as.
  {
    dn: `uid=duplicate,${DEFAULT_BASE_DN}`,
    uid: "duplicate",
    mail: "dup@example.com",
    cn: "Dup One",
    password: "dup-one-password",
  },
  {
    dn: `uid=duplicate,ou=contractors,dc=example,dc=com`,
    uid: "duplicate",
    mail: "dup@example.com",
    cn: "Dup Two",
    password: "dup-two-password",
  },
];

class LdapError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "LdapError";
    this.code = code;
  }
}

/** Result codes a real server returns; the driver may branch on these. */
const CODES = {
  invalidCredentials: 49,
  referral: 10,
  confidentialityRequired: 13,
  operationsError: 1,
};

/**
 * A stand-in LDAP server.
 *
 * @param {{tls?:boolean, allowAnonymous?:boolean, referral?:string,
 *          requireTls?:boolean, startTlsFails?:boolean}} options
 */
function makeDirectory(options = {}) {
  const {
    tls = true,
    allowAnonymous = true,
    referral = null,
    requireTls = true,
    startTlsFails = false,
  } = options;

  const calls = { binds: [], searches: [], startTls: 0 };
  let tlsActive = tls;

  return {
    calls,
    SERVICE_DN,
    SERVICE_PASSWORD,
    BASE_DN: DEFAULT_BASE_DN,
    people: PEOPLE,

    get tlsActive() {
      return tlsActive;
    },

    /**
     * Negotiate StartTLS.
     *
     * When it fails it FAILS. A driver that carries on in plaintext has
     * performed exactly the downgrade the requirement exists to prevent, and the
     * user's password goes out in the clear.
     */
    async startTls() {
      calls.startTls += 1;
      if (startTlsFails)
        throw new LdapError("StartTLS negotiation failed", CODES.operationsError);
      tlsActive = true;
      return true;
    },

    /**
     * Bind as `dn` with `password`.
     *
     * The empty-password case is the point of this whole file: it SUCCEEDS,
     * because that is what RFC 4513 says an unauthenticated bind does. Nothing
     * here is broken — a driver that treats this as authentication is.
     */
    async bind(dn, password) {
      calls.binds.push({ dn, password, tls: tlsActive });

      if (requireTls && !tlsActive)
        throw new LdapError(
          "confidentiality required: bind refused over an unencrypted connection",
          CODES.confidentialityRequired
        );

      // RFC 4513 §5.1.2: DN present, password empty → anonymous bind, SUCCESS.
      if (allowAnonymous && (password === "" || password === undefined || password === null))
        return { authenticated: false, anonymous: true };

      if (dn === SERVICE_DN && password === SERVICE_PASSWORD)
        return { authenticated: true, anonymous: false };

      const person = PEOPLE.find((entry) => entry.dn === dn);
      if (person && person.password === password)
        return { authenticated: true, anonymous: false };

      throw new LdapError("invalid credentials", CODES.invalidCredentials);
    },

    /**
     * Search with a raw filter string.
     *
     * Filters are matched the way a real server matches them — which is to say
     * an injected `)(uid=*` really does widen the match. The mock does not
     * sanitize on the driver's behalf; that is the driver's job, and pretending
     * otherwise would make an injectable driver look safe.
     */
    async search(baseDn, filter) {
      calls.searches.push({ baseDn, filter, tls: tlsActive });

      if (referral) throw new LdapError(`referral: ${referral}`, CODES.referral);

      return PEOPLE.filter(
        (entry) => entry.dn.endsWith(baseDn) && matchesFilter(entry, filter)
      ).map(({ password, ...attributes }) => attributes);
    },
  };
}

/**
 * Evaluate an LDAP filter against one entry.
 *
 * Deliberately permissive about `|`, `&` and `*`, because a real server is. The
 * whole value of the injection fixture is that `uid=*)(uid=*` genuinely matches
 * more than the caller intended.
 */
function matchesFilter(entry, filter) {
  const text = String(filter ?? "");
  const clauses = [...text.matchAll(/\(([a-zA-Z]+)=([^)]*)\)/g)];
  if (clauses.length === 0) return false;

  const matchesOne = ([, attribute, value]) => {
    const actual = entry[attribute];
    if (actual === undefined) return false;
    if (value === "*") return true;
    if (value.includes("*")) {
      const pattern = new RegExp(
        `^${value.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
        "i"
      );
      return pattern.test(String(actual));
    }
    return String(actual).toLowerCase() === value.toLowerCase();
  };

  // An OR anywhere in the filter is what an injected `)(uid=*` produces.
  if (text.startsWith("(|")) return clauses.some(matchesOne);
  return clauses.every(matchesOne);
}

module.exports = {
  makeDirectory,
  LdapError,
  CODES,
  SERVICE_DN,
  SERVICE_PASSWORD,
  DEFAULT_BASE_DN,
  PEOPLE,
};
