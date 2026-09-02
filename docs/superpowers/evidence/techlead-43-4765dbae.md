# Techlead review — #43 `4765dbae` (S2 complete: ACS route + boot warning)

**Verdict: PASS.** Every acceptance criterion from the `01888688` round is closed, and the
two defects Dev3 found unprompted (mount order, Host-derived ACS URL) are the most valuable
things in the commit. Two findings below (one medium, one low) plus two notes — none blocks
the merge; FINDING-1 should be a follow-up rather than a rework.

Static review; `xml-crypto`/`xpath`/`@xmldom/xmldom` are still absent from this checkout's
`server/node_modules`, so the 365 suite was not re-run here.

---

## The four things PMO asked

### (1) Order at the ACS: claim → linkPrincipal

**Correct, and the ordering is enforced by construction rather than by discipline.**
`saml.js:145-153`:

```js
const principal = await driver.completeLogin({ ... });   // verifies, checks, CLAIMS
const { user, created } = await linkPrincipal(principal);
```

The claim is inside `completeLogin`, so the route physically cannot run `linkPrincipal`
first — there is no ordering for a future editor to get wrong, because the two are not
separate steps at this level. That is better than the route calling `claim()` itself in the
right order.

The full chain, verified end to end:

1. `IdentityLoginState.consume(relayState)` — before any XML is parsed, so a replayed POST
   is refused before it costs a signature verification;
2. `completeLogin` → signature (config key) → one-signature/one-reference/one-assertion →
   ID match → **issuer → conditions → audience → InResponseTo → recipient** → claim;
3. `linkPrincipal`;
4. `TemporaryAuthToken.issue/validate`.

The HTTP tests pin the outcome rather than the shape: an unsigned assertion is refused
**and `users.count()` is unchanged**, and a replay returns 401 with no second token. Those
are the two assertions that would fail if the order were ever inverted.

`_checkIssuer` and `_checkRecipient` both landed **before** the claim, which is where my
acceptance criteria said they must go, and both have "records nothing" tests of their own.
That second set matters more than the refusal tests: a check placed after the claim would
still refuse the login while letting an attacker burn the assertion ID.

### (2) Does the Host fallback let the Recipient check agree with itself?

**Yes — and that is now stated loudly rather than fixed, which is the right call.**

The mechanism, to be precise about what the warning is warning about: `acsUrl(request)`
(`saml.js:77-85`) prefers `SSO_ACS_URL`, then `SSO_CALLBACK_BASE_URL`, then
`${request.protocol}://${request.get("host")}`. In the third case the string handed to the
driver as `this.acsUrl` is derived from a header the caller sends, and `_checkRecipient`
compares the signed `Recipient` against it. An attacker replaying an assertion issued for
`https://other-sp.example.com/api/sso/saml/acs` sets `Host: other-sp.example.com` and the
comparison passes. The check does not merely weaken — it verifies nothing.

Removing the fallback would break deployments that have not configured a base URL, so
keeping it and shouting is correct. The warning is well built:

- it fires at **mount**, not first login, so it is on every boot rather than in one request
  log;
- it is silent when SAML is off — an operator who learns to ignore one irrelevant warning
  ignores the relevant ones too, and that reasoning is in the code;
- the test asserts the message **names the Recipient check**, not merely that a variable is
  unset. That distinction is the whole point: "SSO_ACS_URL is not set" reads as a missing
  convenience, which is exactly how a degraded security check gets ignored for a year.
- `samlEnabled()` was extracted so the enable check cannot drift between the two readers.

The comment in `acsUrl` states the property in one line I would keep verbatim: with no
configured value the check is "no worse than not checking, and no better".

### (3) `inviteRateLimit` on `/sso/saml/acs` from the first commit (Q-1)

**Yes.** On both routes, at `cd4fda5e` — the commit that introduced them. The Q-1 test drives
real requests until a 429 arrives rather than inspecting the middleware array, so it proves
the limiter is *mounted and effective*, and the mutation table records that removing it kills
exactly that test. The comment explains the cost model correctly: unauthenticated, and every
call spends an XML parse plus signature verification before it can be refused.

Also correct that `/sso/saml/login` is limited — every call writes an
`identity_login_state` row, so unlimited it is a free way to fill that table.

### (4) Does the mount-order test survive a refactor?

**Partly — and this is the one place I would not leave as is. See FINDING-1.**

The defect itself is real and well found: S1 registers the wildcard `/sso/:provider/login`,
Express matches in registration order, so mounting `samlIdentityEndpoints` second means the
wildcard swallows `/sso/saml/login` and hands `"saml"` to an OIDC-only config builder — a
500 on every SAML login. The ledger says this was found by the HTTP test on its first run,
not by reading, and that a unit test of the handler would have passed while the route was
unreachable. That is exactly right, and it is the same class as the LanceDB mock problem in
#30: the mock cannot fail the way production fails.

What pins it today is that 8 of 9 route tests fail when the order is restored — an
end-to-end consequence, which is durable against most refactors and is the strongest form
available. But **nothing in the tree says the constraint exists** except a comment in
`index.js` and the ledger. A developer who reorders the mounts sees 8 red tests with no
message naming the cause, and the natural reading of "SAML routes broke" is that SAML broke.

---

## FINDING-1 (medium, follow-up not rework) — the mount-order constraint has no named test

Add one assertion that fails with the *reason*:

```js
test("SAML routes are mounted before the wildcard /sso/:provider/login", async () => {
  const response = await request(app).get("/api/sso/saml/login");
  // A 500 here means identityEndpoints was mounted first and its wildcard
  // swallowed this path — see index.js. Not a SAML bug.
  expect(response.status).toBe(302);
});
```

The 8 failing tests prove the same fact; this one *explains* it. Cheap, and it is the
difference between a constraint that survives a refactor and one that survives until someone
has a bad afternoon.

Better still, if PMO wants it: make the wildcard refuse a provider that has its own mount.
Then order stops being load-bearing at all. That is a change to S1's file and belongs in its
own issue, not here.

## FINDING-2 (low) — `consume()` returns the provider and neither route checks it

`IdentityLoginState.consume` returns `{nonce, codeVerifier, provider, redirectUri}`. Neither
`identity.js:114` (OIDC) nor `saml.js:135` (SAML) compares `consumed.provider` against the
provider handling the request.

So a state minted at `/sso/saml/login` can be spent at `/sso/oidc/callback` and vice versa.
Today this is not exploitable — the OIDC path then needs a `code` that resolves against the
OIDC driver, and the SAML path needs an assertion whose `InResponseTo` equals the state and
that verifies against SAML's configured certificate — so a cross-provider state gets no
further than a refusal. It is a free tightening of a value that is already in hand:

```js
if (consumed.provider !== PROVIDER) throw new IdentityAuthenticationError(REFUSED);
```

Both files; one line each. Raising it now because the row already carries the answer, and
the moment a third provider (S3/LDAP) shares this table the reasoning above stops holding on
its own.

## NOTE-A — the ACS reads `SSO_ACS_URL`, the OIDC callback reads `SSO_CALLBACK_BASE_URL`

`saml.js:78` prefers `SSO_ACS_URL` and falls back to `SSO_CALLBACK_BASE_URL`;
`identity.js:49` only knows `SSO_CALLBACK_BASE_URL`. That is a deliberate superset and it
works, but an operator setting only `SSO_ACS_URL` has configured SAML correctly and left
OIDC on the Host fallback — with no warning, because `warnIfRecipientCheckDegraded` is
satisfied by either variable and OIDC has no equivalent check.

Not a defect in #43 (OIDC's redirect URI is echoed back by the IdP and verified differently),
but the two files now disagree about which variable is canonical. One line in the operator
docs, or `identity.js` learning about `SSO_ACS_URL` too.

## NOTE-B — `providerConfig` does not validate its own output

`entityId`, `idpEntityId` and `ssoUrl` are read straight from env and passed to the
constructor, which throws `IdentityConfigurationError` if any is empty. The route catches it
and returns 500 with "Could not start the sign-in flow." Correct behaviour — fails closed,
no oracle — but an operator who left `SSO_SAML_ENTITY_ID` unset gets a 500 with the reason
only in the log line. Given `warnIfRecipientCheckDegraded` already runs at mount, the same
place could check the four required variables and say which one is missing. Small, and it
would have to skip when SAML is off, same as the existing warning.

---

## Also verified

- **`_checkRecipient` reads from inside the signed assertion**, and the comment says why
  `Response/@Destination` is not a substitute (outside the signature — fine for a fast
  refusal, never for a decision). `@Destination` remains unchecked, which is acceptable
  precisely because `Recipient` is checked; if `Recipient` were ever dropped, `@Destination`
  alone would not replace it.
- **`_checkIssuer` closes the two-provider hole** I raised: "some trusted key signed this" is
  not enough when a trust list holds several certificates during rotation. Fixture
  `wrongIssuer` signs with the *trusted* key and changes only the Issuer, which is the
  correct isolation.
- **`wrongRecipient` likewise changes only the delivery address** — everything else verifies.
  Both fixtures were made possible by threading `recipient` and `issuer` through
  `assertionXml`, so they are variations of the valid fixture rather than separate documents.
- **NIT-1 (Status) closed correctly**: the status value goes to `console.error` and never to
  the response. A `Response` with no assertion usually means the IdP refused — account
  disabled, MFA declined, unknown user — and putting that in the response body would tell an
  attacker which accounts exist.
- **NIT-2 (Conditions/Audience pairing) closed by comment**, and the comment says the right
  thing: conditions bound WHEN, audience bounds WHERE, recipient is a third axis. It
  explicitly warns a future reviewer against removing "the duplicate". That was the risk I
  described.
- **The route decides no policy**: R1's 409 travels through unchanged with its actionable
  message, everything else is one flat 401, and the oracle test asserts the body does not
  match `/signature|audience|replay|expired/i`.
- **`the session belongs to a real user holding a role grant`** — asserts exactly one grant
  and that it is `member`. §7.5: a user the engine denies is not a logged-in user however
  valid the assertion was. This is the test that would catch `syncLegacyRoleGrant` being
  dropped from `linkPrincipal`.
- **The happy path proves the token opens a protected route** rather than merely that a
  string was returned.
- `IdentityLoginState.consume` is consumed **before** parsing, and its conditional
  `updateMany` (`consumedAt: null` + unexpired in the WHERE) means two concurrent ACS posts
  cannot both proceed.
- Mutation table covers all four rounds; the two mutants for this round (`identityEndpoints`
  first → 8 of 9 route tests; drop `inviteRateLimit` → exactly the Q-1 test) kill what they
  should and nothing more.
