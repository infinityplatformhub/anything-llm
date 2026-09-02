<<<<<<< HEAD

### PMO rulings after Techlead-1 fixture review (da87ec42 FAIL)
- Every mock entry carries `objectClass`; the mock parses `&`/`|`/nested filters; injection fixture is the naive-driver shape `(&(objectClass=…)(uid=*)(uid=*))` and must return everyone.
- `Alice.Smith` DN-case entry exists; driver binds the DN returned by search.
- `search()` requires an authenticated service bind (anonymous read closed).
- Anonymous (§5.1.1) and unauthenticated (§5.1.2) binds are separate flags/tests; `bind(SERVICE_DN,"")` then search is refused.
- `escapeDn` escapes NUL; legit `(`/`*` in cn/mail must still match.
- Zero-result byte-identity is a route-level assertion.
- Ruling (FINDING-5, slot 092000 after route merge): shape-derived row CHECK on identity_providers, no discriminator column; `entityId`/`ssoUrl` empty-string = "not SAML" is a documented contract (COMMENT ON COLUMN + information_schema nullable test); 5 tests incl. mixed rows both directions and literal empty ldapUrl; no NOT VALID.
=======
# Recon — S3 LDAP (#?) · read-only, nothing committed to code

Read against `approof/s2-saml` @ `4765dbae`. No files outside this one were touched.

## 1. What already exists that S3 must fit into

The seam is real and load-bearing now — two drivers share it, so the third is the
one that proves whether it was designed or merely described.

| piece | file | S3's obligation |
|---|---|---|
| registry | `utils/identityProviders/index.js` | ONE line, keyed by `providerId()`. Null-prototype lookup already handles user-supplied ids. |
| core policy | `utils/identity/linkPrincipal.js` | Do not touch. R1/R2, the handle rules and the suffix retry are shared; a third copy is the thing the seam exists to prevent. |
| username derivation | `utils/identity/deriveUsername.js` | Use `deriveUsername` / `usernameCandidates` as-is. NFC+lowercase via `normalizeForCompare`. |
| errors | `utils/identityProviders/errors.js` | Reuse. `IdentityUnavailableError` is the ONLY retryable one — for LDAP that means a dead directory, never a bad password. |
| driver interface | `OidcIdentityProvider`, `SamlIdentityProvider` | `providerId()`, `capabilities()`, `validateConnection()`, `beginLogin()`, `completeLogin()`, `refreshPrincipal()`, `revokeSession()`, `listPrincipals()`, `listGroups()`. |

Parameter names are already provider-neutral (`stateToken`, `callbackParams`)
because S1 anticipated exactly this. S3 should not need to widen them.

## 2. Where LDAP genuinely differs — and why the S2 shape does not transfer cleanly

This is the part worth deciding BEFORE writing code, because two of S2's core
rulings do not carry over:

**a. There is no redirect and no assertion.** OIDC and SAML both hand the browser
to an IdP and get a signed document back. LDAP takes a **username and password
directly** and binds with them. That inverts the threat model:

- No XSW, no signature, no assertion ID → **`identity_assertion_ids` is not
  reused**, and neither is `identity_login_state`. There is no in-flight login.
- But the application now HOLDS the user's directory password in memory, which
  neither S1 nor S2 ever did. That is the single biggest new risk in S3 and it
  has no precedent in this codebase to copy.
- `beginLogin()` has no meaningful implementation. Whether it throws
  `IdentityCapabilityError` or returns a local form URL is a ruling to get from
  PMO, not something to invent.

**b. The bind credential is a real secret.** S2's certificates are public
material, so `SSO_SAML_CERTIFICATE` in env was defensible. A service-account bind
DN password is NOT: it belongs in `CredentialStore` (AES-256-GCM, AAD-bound),
the same call S1 already makes for the OIDC client secret. Env is a bootstrap
path at most.

**c. "Key/bind from config only" means something sharper here.** For SAML it
meant "never read the key from the assertion". The LDAP analogue is: **never let
the directory's response decide who the user is beyond the DN we searched for.**
Specifically, a search that returns multiple entries must be a refusal, not a
"take the first" — that is the same class of bug as XSW's document order.

## 3. Fixtures first (§7.9b), and what they must actually contain

The S2 lesson generalizes with one addition learned the hard way in `01888688`:
**a fixture must match the shape the code actually reads, not merely the name of
the thing being guarded.** Two of my XSW fixtures planted bare elements the
driver's read path could never reach; they passed against a deliberately unsafe
mutant and proved nothing.

For LDAP the equivalent trap is a mock directory that is too obliging. Candidate
fixtures, written before choosing a library:

1. **LDAP injection in the username** — `*)(uid=*` and `admin)(|(uid=*` in the
   search filter. If the driver builds filters by string concatenation, one of
   these authenticates as somebody else. This is S3's XSW: the attack the library
   exists to prevent.
2. **Empty-password anonymous bind** — RFC 4513: a bind with a DN and an empty
   password SUCCEEDS as an anonymous bind on many servers. A driver that reads
   "bind did not error" as "password correct" logs in anyone who submits a blank
   password. This one has burned real products.
3. **Unauthenticated bind** — same shape, password present but server configured
   to allow it.
4. **Multiple search results** — must refuse, never take the first.
5. **Zero results** — must be indistinguishable, to the caller, from a wrong
   password (no user-enumeration oracle).
6. **Referral response** — the directory pointing at another server; following it
   blindly is a way to have authentication answered by a host we never chose.
7. **StartTLS downgrade / no TLS** — a bind over plaintext ships the user's
   password in the clear. Whether this is a hard refusal or a loud warning is a
   ruling (compare `4765dbae`'s Host-header warning: a check that degrades
   silently is worse than one absent).
8. **DN case/whitespace variance** — the same person's DN in two forms must not
   become two accounts, which is where `deriveUsername` already helps.

## 4. Open questions for PMO — not to be guessed

1. **Password handling**: does S3 hold the user's password at all (direct bind),
   or is it search-then-bind with a service account? Both are standard; they have
   different blast radii and the choice drives everything else.
2. **`beginLogin()`**: capability error, or a local form? Affects the route shape.
3. **Plaintext LDAP**: refuse outright, or warn like the Host-header case?
4. **Where does the login form live** — new route, or the existing local login
   path with a provider selector? The second touches S1/S2's routes and would
   need care about the wildcard mount order that bit me in `cd4fda5e`.
5. **`listPrincipals`/`listGroups`**: LDAP can genuinely do directory sync, unlike
   OIDC and SAML. Is that S3's scope, or still S4's? `capabilities()` must not
   claim what the driver will not honour.

## 5. Traps carried forward

- Run jest under **node@22**; under node 26 `jsonwebtoken` throws at import and
  suites fail to LOAD while the `Tests:` line still reads green (§7.9a).
- `API_KEY_PEPPER` must be **≥32 bytes** or 8 authorization suites die at import
  with a message about the pepper, not about the test (§7.1).
- Mount order: `/sso/:provider/login` is a wildcard registered by S1. Any new
  concrete route under `/sso/` must be mounted BEFORE it.
- A test DB is built by `migrate deploy`, never `db push` (§7.1a).

---

## 6. PMO rulings — the five open questions, answered

Recorded verbatim in effect. Sections 2–4 above were written before these; where
they speculate, this section governs.

Ruling: **search-then-bind with a service account**, not direct bind. The bind DN
and its password live in `CredentialStore` (`KEY_MAPPING` `secret: true`), never
in env — unlike S2's certificates, which are public material. The search must
return **exactly one entry**: 0 or >1 is REFUSED, with the same message a wrong
password gets, so the route is never a user-enumeration oracle. Filters are built
with RFC 4515 escaping, never string concatenation. Only then is the user's
password used to bind the DN the search returned.

Ruling: `beginLogin()` throws `IdentityCapabilityError` — there is no redirect to
begin. `capabilities()` declares `password: true, redirect: false`.

Ruling: **plaintext LDAP is refused** unless `LDAP_ALLOW_INSECURE=1`, which logs
an error on every boot (the `4765dbae` Host-fallback pattern: a protection that
degrades silently is worse than one absent). `ldaps://` or StartTLS is mandatory
with certificate validation on, and a failed StartTLS is a failure — never a
fallback to plaintext, which is the downgrade the requirement exists to stop.

Ruling: a new route `POST /sso/ldap/login`, mounted BEFORE S1's
`/sso/:provider/login` wildcard with a test pinning that order (the defect found
in `cd4fda5e`), carrying `inviteRateLimit` from the first commit. The password is
never logged, never written to the audit trail, never held beyond the bind call,
and its variable is zeroed afterwards — best-effort in JS, and commented as such
so nobody mistakes it for a guarantee. Minimum UI for S3 is a password input on
the existing Login page when the ldap provider is enabled.

Ruling: `listPrincipals` / `listGroups` remain **S4**. LDAP could genuinely do
directory sync, which is exactly why `capabilities()` must not claim it before
the code honours it.

### Mandatory fixtures (RED before any fix)

Written before choosing a library, per §7.9b, and shaped to match the code path
actually read (the `01888688` lesson — a fixture that cannot reach the read it
targets proves nothing):

| fixture | required behaviour |
|---|---|
| empty password | REFUSED **before** the bind — the credential never reaches the server |
| unauthenticated bind | refused |
| LDAP injection `*)(uid=*` | escaped; authenticates nobody |
| multiple search results | refused |
| zero search results | body identical to a wrong password, byte for byte |
| referral | not followed |
| DN case variance | the DN from the SEARCH is used, never the user's input |
| StartTLS downgrade | fails; never falls back to plaintext |

### Schema

One `identity_providers` row (`provider='ldap'`) is expected to suffice: url,
baseDn, userFilter and the attribute map fit the existing config columns, and
there is no secret column by design. If a new column proves necessary it takes
slot `091000` — `090000` belongs to #50.
>>>>>>> 17aadd2f
