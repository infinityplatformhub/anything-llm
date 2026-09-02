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
//   * RFC 4513 §5.1.2 — an UNAUTHENTICATED bind (a DN with an empty password)
//     succeeds. A driver reading "bind did not throw" as "password correct"
//     admits anyone who submits a blank password. This is the single most
//     dangerous thing about LDAP authentication and it has burned real products.
//   * RFC 4513 §5.1.1 — an ANONYMOUS bind (empty DN and empty password) is a
//     different operation with the same trap. Kept separate because a driver can
//     get one right and the other wrong.
//   * A search filter built by concatenation is injectable, exactly like SQL.
//   * A search can return MANY entries, and "take the first" is the LDAP
//     spelling of S2's XSW document-order bug.
//   * A server can answer with a REFERRAL — "ask that host instead" — which, if
//     followed, means authentication was answered by a server nobody chose.
//   * Anonymous READ is disabled, as on any hardened directory: a search issued
//     before a successful service bind is refused.
//
// S2's lesson applies here too (#43, commit 01888688): a fixture must match the
// shape the code actually READS, not merely name the thing being guarded.
//
// Techlead's FAIL on da87ec42 found exactly that defect in the first version of
// this file. The filter matcher special-cased a leading `(|` and otherwise
// required every clause, so it never really parsed `&`. A realistic base filter
// — `(&(objectClass=inetOrgPerson)(uid=...))`, which is what a driver actually
// writes — could be injected without the mock noticing, and a concatenating
// driver looked safe. The parser below is real: `&`, `|`, `!`, nesting,
// substrings, and RFC 4515 hex unescaping.

const DEFAULT_BASE_DN = "ou=people,dc=example,dc=com";

/** The service account the driver binds as before searching (PMO ruling 1). */
const SERVICE_DN = "cn=svc-approof,ou=services,dc=example,dc=com";
const SERVICE_PASSWORD = "service-account-password";

/** What a real directory's user entries carry, and what a real filter matches on. */
const PERSON_CLASS = "inetOrgPerson";

const PEOPLE = [
  {
    dn: `uid=alice,${DEFAULT_BASE_DN}`,
    objectClass: PERSON_CLASS,
    uid: "alice",
    mail: "alice@example.com",
    cn: "Alice Smith",
    password: "alice-correct-password",
  },
  // DN case variance. DNs are case-insensitive, so a driver that keyed on the
  // user's input rather than on the DN the SEARCH returned would treat this as
  // a different person from the entry above — or bind a DN that does not exist.
  {
    dn: `UID=Alice.Smith,OU=People,DC=Example,DC=com`,
    objectClass: PERSON_CLASS,
    uid: "Alice.Smith",
    mail: "alice.smith@example.com",
    cn: "Alice Smith",
    password: "alice-smith-password",
  },
  {
    dn: `uid=bob,${DEFAULT_BASE_DN}`,
    objectClass: PERSON_CLASS,
    uid: "bob",
    mail: "bob@example.com",
    cn: "Bob Jones",
    password: "bob-correct-password",
  },
  // Values that are perfectly legal in a directory but special in a filter.
  // Escaping must PRESERVE them: a driver that strips them cannot find this
  // person, and one that passes them through raw corrupts its own filter.
  {
    dn: `uid=oddball,${DEFAULT_BASE_DN}`,
    objectClass: PERSON_CLASS,
    uid: "oddball",
    mail: "o(dd)*ball@example.com",
    cn: "O(dd) *Ball",
    password: "oddball-password",
  },
  // Two entries a careless filter can match at once. The driver must refuse
  // rather than pick one: choosing between them is choosing who to log in as.
  {
    dn: `uid=duplicate,${DEFAULT_BASE_DN}`,
    objectClass: PERSON_CLASS,
    uid: "duplicate",
    mail: "dup@example.com",
    cn: "Dup One",
    password: "dup-one-password",
  },
  {
    dn: `uid=duplicate,ou=contractors,dc=example,dc=com`,
    objectClass: PERSON_CLASS,
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
  operationsError: 1,
  referral: 10,
  confidentialityRequired: 13,
  invalidCredentials: 49,
  insufficientAccess: 50,
};

/**
 * A stand-in LDAP server.
 *
 * @param {{tls?:boolean, allowUnauthenticated?:boolean, allowAnonymous?:boolean,
 *          referral?:string, requireTls?:boolean, startTlsFails?:boolean,
 *          alwaysAnonymous?:boolean}} options
 */
function makeDirectory(options = {}) {
  const {
    tls = true,
    // RFC 4513 §5.1.2: a DN with an empty password. The dangerous one.
    allowUnauthenticated = true,
    // RFC 4513 §5.1.1: an empty DN with an empty password.
    allowAnonymous = true,
    referral = null,
    requireTls = true,
    startTlsFails = false,
    // A misconfigured server that resolves USER binds anonymously. Only the
    // `authenticated` flag distinguishes it; nothing throws. The service account
    // still authenticates normally, so a driver reaches the user bind and has to
    // read the flag there.
    alwaysAnonymous = false,
    // The same fault at the SERVICE bind. Separate, because the two checks live
    // at different points and a driver can get one right and the other wrong —
    // and because a single flag covering both would stop the user-bind test at
    // the service bind, proving only the earlier check (§7.9c).
    serviceBindAnonymous = false,
  } = options;

  const calls = { binds: [], searches: [], startTls: 0 };
  let tlsActive = tls;
  // Anonymous read is DISABLED, as on any hardened directory. A search before a
  // successful service bind is refused, so a driver that skips that bind — or
  // swallows its failure — cannot quietly fall back to whatever the directory
  // shows the world.
  let boundAuthenticated = false;

  return {
    calls,
    SERVICE_DN,
    SERVICE_PASSWORD,
    BASE_DN: DEFAULT_BASE_DN,
    PERSON_CLASS,
    people: PEOPLE,

    get tlsActive() {
      return tlsActive;
    },
    get boundAuthenticated() {
      return boundAuthenticated;
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
    // ldapts spells it startTLS; both names reach the same server.
    async startTLS() {
      return this.startTls();
    },

    /**
     * Bind as `dn` with `password`.
     *
     * The empty-password cases are the point of this whole file: they SUCCEED,
     * because that is what RFC 4513 says. Nothing here is broken — a driver that
     * treats either as authentication is.
     */
    async bind(dn, password) {
      calls.binds.push({ dn, password, tls: tlsActive });

      if (requireTls && !tlsActive)
        throw new LdapError(
          "confidentiality required: bind refused over an unencrypted connection",
          CODES.confidentialityRequired
        );

      // QA-1 G2: a real server can answer a BIND with a referral, not only a
      // search. A driver that handles referrals on one operation and not the
      // other has a hole on whichever it forgot.
      if (referral) throw new LdapError(`referral: ${referral}`, CODES.referral);

      const emptyPassword =
        password === "" || password === undefined || password === null;
      const emptyDn = dn === "" || dn === undefined || dn === null;

      // §5.1.1 anonymous: no DN, no password. Succeeds, authenticates nobody.
      if (allowAnonymous && emptyDn && emptyPassword) {
        boundAuthenticated = false;
        return { authenticated: false, anonymous: true, unauthenticated: false };
      }

      // §5.1.2 unauthenticated: a DN, but no password. ALSO succeeds — and this
      // is the one that looks like a real login to a careless driver.
      if (allowUnauthenticated && !emptyDn && emptyPassword) {
        boundAuthenticated = false;
        return { authenticated: false, anonymous: true, unauthenticated: true };
      }

      // A misconfigured server resolving the SERVICE bind anonymously. It does
      // not throw, so a thrown error cannot be caught and reclassified one layer
      // up — only the flag says anything is wrong. This is what makes the
      // service-bind flag check reachable by a test at all (§7.9c).
      if (serviceBindAnonymous && dn === SERVICE_DN) {
        boundAuthenticated = false;
        return { authenticated: false, anonymous: true, unauthenticated: false };
      }

      // The same fault at a USER bind. The password here is perfectly ordinary,
      // so an empty-password guard cannot catch it.
      if (alwaysAnonymous && dn !== SERVICE_DN) {
        boundAuthenticated = false;
        return { authenticated: false, anonymous: true, unauthenticated: false };
      }

      if (dn === SERVICE_DN && password === SERVICE_PASSWORD) {
        boundAuthenticated = true;
        return { authenticated: true, anonymous: false, unauthenticated: false };
      }

      // DNs are case-insensitive, so the bind must be too — otherwise the mock
      // would reject a DN it had just handed out from a search.
      const person = PEOPLE.find(
        (entry) => entry.dn.toLowerCase() === String(dn).toLowerCase()
      );
      if (person && person.password === password) {
        boundAuthenticated = true;
        return { authenticated: true, anonymous: false, unauthenticated: false };
      }

      boundAuthenticated = false;
      throw new LdapError("invalid credentials", CODES.invalidCredentials);
    },

    /**
     * Search with a raw filter string.
     *
     * Filters are parsed the way a real server parses them, so an injected
     * `*)(uid=*` genuinely widens an `&`-based base filter. The mock does not
     * sanitize on the driver's behalf; that is the driver's job, and pretending
     * otherwise makes an injectable driver look safe — which is exactly the
     * defect Techlead found in the first version of this file.
     */
    async search(baseDn, filter) {
      calls.searches.push({ baseDn, filter, tls: tlsActive });

      // QA-1 G1: the transport requirement applies to EVERY operation, not just
      // the bind. After a failed StartTLS a search must be refused too —
      // otherwise a driver could be caught sending the password in the clear
      // while still reading the directory over the same plaintext connection.
      if (requireTls && !tlsActive)
        throw new LdapError(
          "confidentiality required: search refused over an unencrypted connection",
          CODES.confidentialityRequired
        );

      // Anonymous read is off. A driver that skipped the service bind, or
      // swallowed its failure, gets nothing rather than a public subset.
      if (!boundAuthenticated)
        throw new LdapError(
          "insufficient access: anonymous search is not permitted",
          CODES.insufficientAccess
        );

      if (referral) throw new LdapError(`referral: ${referral}`, CODES.referral);

      const parsed = parseFilter(String(filter ?? ""));
      // A malformed filter is a protocol error, not "matches nothing": silently
      // matching nothing would let a broken filter look like a correct refusal.
      if (!parsed) throw new LdapError("bad search filter", CODES.operationsError);

      const base = String(baseDn ?? "").toLowerCase();
      return PEOPLE.filter(
        (entry) => entry.dn.toLowerCase().endsWith(base) && evaluate(parsed, entry)
      ).map(({ password, ...attributes }) => attributes);
    },

    async unbind() {
      boundAuthenticated = false;
    },
  };
}

// ---------------------------------------------------------------------------
// A real RFC 4515 filter parser.
//
// Real because the previous shortcut — "starts with `(|` → some, otherwise
// every" — is precisely what let an injected `&` filter pass unnoticed. A mock
// that cannot parse the filters a driver actually writes cannot prove anything
// about how the driver writes them.
// ---------------------------------------------------------------------------

/** @returns {Object|null} an AST, or null when the filter is malformed. */
function parseFilter(text) {
  let index = 0;

  function parse() {
    if (text[index] !== "(") return null;
    index += 1;

    const operator = text[index];
    if (operator === "&" || operator === "|" || operator === "!") {
      index += 1;
      const children = [];
      while (index < text.length && text[index] === "(") {
        const child = parse();
        if (!child) return null;
        children.push(child);
      }
      if (text[index] !== ")") return null;
      index += 1;
      if (children.length === 0) return null;
      if (operator === "!" && children.length !== 1) return null;
      return { type: operator, children };
    }

    const close = text.indexOf(")", index);
    if (close === -1) return null;
    const clause = text.slice(index, close);
    index = close + 1;

    const equals = clause.indexOf("=");
    if (equals === -1) return null;
    return {
      type: "=",
      attribute: clause.slice(0, equals),
      value: clause.slice(equals + 1),
    };
  }

  const ast = parse();
  // Trailing junk means the filter was not the filter the caller thought it was.
  if (!ast || index !== text.length) return null;
  return ast;
}

/** Unescape the RFC 4515 hex forms the way a server does. */
function unescape(value) {
  return value.replace(/\\([0-9a-fA-F]{2})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
}

function evaluate(node, entry) {
  if (node.type === "&") return node.children.every((c) => evaluate(c, entry));
  if (node.type === "|") return node.children.some((c) => evaluate(c, entry));
  if (node.type === "!") return !evaluate(node.children[0], entry);

  const actual = entry[node.attribute];
  if (actual === undefined) return false;

  // A bare `*` is a presence test; an UNESCAPED `*` inside a value is a
  // substring match. Only unescaped ones count — which is the entire point of
  // escaping, and what makes "escaping preserves the value" a real assertion
  // rather than a tautology.
  if (node.value === "*") return true;
  const hasUnescapedStar = /(?<!\\)\*/.test(node.value);
  if (hasUnescapedStar) {
    const pattern = node.value
      .split(/(?<!\\)\*/)
      .map((part) => unescape(part).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${pattern}$`, "i").test(String(actual));
  }
  return String(actual).toLowerCase() === unescape(node.value).toLowerCase();
}

module.exports = {
  makeDirectory,
  parseFilter,
  LdapError,
  CODES,
  SERVICE_DN,
  SERVICE_PASSWORD,
  DEFAULT_BASE_DN,
  PERSON_CLASS,
  PEOPLE,
};
