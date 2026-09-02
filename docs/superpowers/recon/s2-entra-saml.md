# S2 recon — Entra SAML

Lane B, month 3. Base `approof/main`. Backlog: *"login ผ่าน Entra SAML ได้, metadata upload จาก UI"*, depends on **S1**, ≈2 cw.

Seam: `docs/superpowers/design/seams/01-identity-provider.md` — same seam as S1. **The seam mentions SAML nowhere**, and that is the central fact of this recon (§1).

## 0. Why 2 cw is only true if S1 did its job

S2 is small **only** because S1 built the core half: `linkPrincipal.js`, `identity_links`, domain policy, role assignment, session issuance. S2 adds one driver.

If S1 leaked any of that into `OidcIdentityProvider`, S2 becomes a rewrite and the estimate is wrong. **The first task in S2 is to check that, before writing SAML code.** Concretely: `grep` the OIDC driver for `users.create`, `users.update`, session/JWT signing, and role assignment. Any hit is S1 debt that S2 pays.

This is the check S1's recon set up by calling out the boundary (*"Driver MUST NOT create/update local users, issue app sessions/JWTs, grant roles"*). S2 is where it gets tested for real, because a second driver is the only thing that proves the first one was actually a driver.

## 1. The seam does not fit SAML, and pretending it does is the trap

Seam 01's driver contract is OAuth-shaped:

```js
async beginLogin({redirectUri, state, nonce})   → {authorizationUrl, state}
async completeLogin({redirectUri, code, state, expectedNonce}) → ExternalPrincipal
async refreshPrincipal({subject, refreshToken}) → ExternalPrincipal
```

SAML has no `code`, no `nonce`, and no refresh token. The mapping is not one-to-one:

| Seam parameter | SAML reality |
|---|---|
| `code` | There is none — the IdP POSTs a signed `SAMLResponse` to the ACS endpoint |
| `nonce` | No equivalent. Replay is prevented by `InResponseTo` + assertion ID + `NotOnOrAfter` |
| `state` | `RelayState`, which is opaque and **not integrity-protected by SAML itself** |
| `refreshToken` | Does not exist. Re-authentication is a new redirect |

Three options, and this needs a ruling before code:

- **(a) Map SAML onto the existing signatures.** `code` carries the base64 `SAMLResponse`; `expectedNonce` carries the expected `InResponseTo`. Nothing in the seam changes. The cost is that the parameter names lie, and the next person reads `code` and assumes OAuth.
- **(b) Add a second contract shape to the seam** — `beginLogin`/`completeAssertion`, with `capabilities()` declaring which a driver speaks. Honest, and it is a change to a Phase-0 contract that four tracks depend on.
- **(c) Keep the signatures, rename the parameters generically** (`credential`, `expectedCorrelation`) and document both bindings. Smallest honest change.

**Recommend (c).** (a) is a lie that costs an hour of confusion every time someone new reads the seam; (b) is a contract change for one driver, and S3 (LDAP) will not fit either shape anyway — LDAP has no redirect at all. (c) survives all three. Whichever is chosen, **decide before writing the driver**, because the decision shapes every test.

`refreshPrincipal` should throw `IdentityCapabilityError` for SAML rather than pretending. That is exactly what seam §Boundaries already requires of a driver advertising a false capability.

## 2. Owner files

**New**
- `server/utils/identityProviders/SamlIdentityProvider/index.js` — driver
- `server/utils/identityProviders/SamlIdentityProvider/metadata.js` — parse IdP metadata XML, emit SP metadata
- `server/endpoints/identity/saml.js` — `POST /sso/saml/acs` (assertion consumer), `GET /sso/saml/metadata`
- `server/__tests__/security/identity/saml*.test.js`

**Modified**
- `server/utils/identityProviders/index.js` — register the driver (one line; S1 built the registry)
- `server/prisma/schema.prisma` — `identity_providers` config table (§3)
- `frontend/src/…/settings/` — metadata upload UI

**Not touched:** `linkPrincipal.js`, `identity_links`, `actorResolver.js`.

`actorResolver.js` is a hard constraint, not a preference. SAML ends at
`locals.user` exactly like every other user ingress (rows 1/4/5/7), so the
resolver already handles it — and it is the single Actor construction site that
T-2 established and three tracks have queued behind. **If S2 finds itself editing
the resolver, the driver is doing core's job**; that is the §0 check failing, not
a resolver gap.

`identity_links` is S1's table and S2 reads and writes rows through
`linkPrincipal.js`, never directly. Two writers to a `@@unique([provider,
subject])` constraint is how a linking policy quietly forks.

## 3. Migration

S1 takes `060000`. **S2 takes `061000`** (PMO ruling) — the same decade as S1,
since both are seam-01 work and reading the migration list should show identity
as one block rather than two unrelated hours.

S1 configures one provider from env. S2 cannot: SAML needs per-deployment IdP metadata (entityID, SSO URL, X.509 signing certificate), and the backlog explicitly wants it uploaded from the UI. So S2 introduces the config table S1 did without:

```prisma
model identity_providers {
  id          Int      @id @default(autoincrement())
  provider    String   @unique     // "oidc" | "saml"
  displayName String
  enabled     Boolean  @default(false)
  config      String                // JSON; secrets by reference, never inline
  createdAt   DateTime @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @db.Timestamptz(3)
}
```

Two things to be explicit about:

- **The signing certificate is public** (it verifies, it does not sign on our side) so it may live in `config`. **An SP private key, if we ever sign requests, may not** — that goes to credential storage. Say which the deployment does.
- Migrating S1's env-based OIDC config into this table is a follow-up, not S2's job. Two config paths for one seam is debt; **record it as such** rather than letting it become the permanent shape.

## 4. RED DoD

Every one fails before the driver exists. SAML's failure modes are signature-shaped, and each is a separate way to forge a login.

1. **Unsigned assertion rejected.** The single most common SAML vulnerability. An assertion with no signature must throw `IdentityAuthenticationError`, never be accepted because its contents look right.
2. **Signature by the wrong key rejected** — valid XML signature, key not the configured IdP certificate.
3. **XML Signature Wrapping (XSW).** A document containing a validly signed assertion *plus* an injected unsigned one, arranged so a naive parser validates the first and reads the second. **This is the attack SAML libraries exist to prevent and hand-rolled parsers fail.** At least two XSW variants as fixtures. If the chosen library cannot be shown to resist these, choose a different library.
4. **Expired assertion rejected** — `NotOnOrAfter` in the past.
5. **`NotBefore` in the future rejected** — with a stated clock-skew allowance (60s is conventional); the allowance is a constant with a comment, not a magic number.
6. **Wrong audience rejected** — `AudienceRestriction` not matching our entityID.
7. **Replay rejected** — the same assertion ID twice. Needs an assertion-ID store with a TTL ≥ the assertion lifetime. **This is a table S2 must not forget**, and it is the SAML equivalent of S1's `identity_login_state.consumedAt`.
8. **`InResponseTo` mismatch rejected** — an unsolicited assertion, or one answering a different request.
9. **`RelayState` is not trusted.** Assert that a tampered `RelayState` cannot redirect the user off-site. SAML does not integrity-protect it; treat it as an index into server-side state, never as a URL.
10. **`provider + subject` linking, same as OIDC** — `NameID` is the subject. Assert that S1's `linkPrincipal` is reused and R1's reject-auto-link ruling holds identically. A second linking policy is the failure this test exists to catch.
11. **HTTP end to end** — POST a signed fixture assertion to `/sso/saml/acs`, get a session JWT `validatedRequest` accepts. Real Postgres, `migrate deploy` (§7.1a).
12. **`locals.user` and nothing else** (§7.5) — S2 adds an ingress; test the contract it writes.
13. **`refreshPrincipal` throws `IdentityCapabilityError`** (§1).

## 5. Library ruling

Do not hand-roll XML signature verification. XSW exists precisely because XML-DSig lets a signature reference a subtree while the reader takes a different one — this is not something to get right from first principles under a 2 cw estimate.

Evaluate the maintained Node SAML libraries against DoD 1–3 **as the selection criterion**: write the XSW fixtures first, then pick the library that fails them correctly. A library chosen by popularity and validated afterwards is the same work in the wrong order.

## 6. Collision

- **S1** — must be merged first; S2 registers into the registry S1 builds.
- **S13 MFA** (lane B, overlapping) — wraps the same post-authentication path. Both S1 and S2 must funnel through `linkPrincipal.js` so S13 inserts one step. **Two ingresses that each create sessions their own way is two places S13 has to patch**, and it will only be told about one.
- **S3 LDAP** (month 3, same lane) — same seam, no redirect at all. §1's ruling should be made with S3 in view, not just SAML.
- **Frontend settings** — lane D owns `frontend/` settings zones per the schedule. The metadata upload UI is lane D's; S2 ships the API and the spec. Do not write the page in lane B.

## 7. Estimate

2 cw holds **if** §0 finds no S1 debt and §5's library choice lands early. The XSW fixtures are the long pole; budget them as work, not as a test-writing afterthought.

---

## §PMO addendum — what S2 needs S1 to leave behind (written for Dev3, before S1 starts)

S1 is being implemented now (#36, slots `080000`/`081000`); S2 follows on `082000`.
This section exists so S1's author can see, while building, which decisions S2 is
about to depend on. Every item below is cheap to get right in S1 and expensive to
retrofit once one driver has shipped.

### The dependency is `identity_links`, and S2 never writes it directly

S2 reads and writes identity links **only** through `linkPrincipal.js`. The
`@@unique([provider, subject])` constraint is what makes "one external identity,
one local user" true, and two writers to it is how a linking policy quietly forks
— OIDC and SAML would each enforce their own idea of what may be linked, and the
difference would only surface as a takeover.

Concretely, S2 depends on S1 having put these in **core**, not in the OIDC driver:

| What | Where it must live | Why S2 cares |
|---|---|---|
| Creating/updating the local `users` row | `linkPrincipal.js` | S2 adds no second user-creation path |
| The `provider + subject` lookup and link write | `linkPrincipal.js` | SAML's `NameID` is the subject; identical policy |
| Domain policy (which email domains may auto-provision) | `linkPrincipal.js` | Must not differ per protocol |
| Role assignment on first login | `linkPrincipal.js` | Two role policies is a privilege bug, not a style issue |
| Session/JWT issuance | the existing `TemporaryAuthToken`→`sessionToken` path | S2 issues sessions the same way or S13 MFA has two paths to patch |
| The reject-auto-link ruling (R1) | `linkPrincipal.js` | S2's DoD #10 asserts S1's policy, not a copy of it |

**The check that proves it:** grep the OIDC driver for `users.create`, `users.update`,
JWT signing, and `grantRole`. Any hit is S1 debt, and S2's 2 cw estimate is wrong by
however much of it there is. This is §0 of this recon; it is repeated here because it
is far cheaper as a thing S1 avoids than as a thing S2 discovers.

### Slot correction

§3 above says S1 takes `060000` and S2 `061000`. **Superseded:** `060000` went to
`credential_store` and the T-7 slots took `070000`/`071000`. S1 is now `080000`/`081000`
and **S2 takes `082000`** — still one identity block, one decade later.

### Files S2 will touch, so S1 knows what not to close over

**S2 creates:** `utils/identityProviders/SamlIdentityProvider/{index,metadata}.js`,
`endpoints/identity/saml.js`, `__tests__/security/identity/saml*.test.js`, and the
`identity_providers` config table plus an assertion-ID replay store (§4.7 — S2's
equivalent of S1's `identity_login_state.consumedAt`; S1 need not build it, but the
two should look alike).

**S2 modifies exactly two of S1's files:**
- `utils/identityProviders/index.js` — one line registering the driver. S1 should make
  the registry take a driver without editing anything else; if adding a provider means
  touching a switch statement, say so now.
- `prisma/schema.prisma` — additive only.

**S2 must not touch, and will treat as a bug in itself if it does:**
`linkPrincipal.js`, `identity_links`, and `actorResolver.js`. The resolver especially:
SAML ends at `locals.user` like every other user ingress, and it is the single Actor
construction site three tracks are queued behind.

### One decision S1 can make cheaply and S2 cannot

§1 above needs a ruling on the driver signatures, because SAML has no `code`, no
`nonce`, and no refresh token. The recommendation is **(c)**: keep the shapes, rename
the parameters generically (`credential`, `expectedCorrelation`), document both
bindings. **If S1 names them `code` and `nonce`, option (c) becomes a rename across a
shipped driver** rather than a naming choice in a new one — so S1 should either adopt
the generic names now or record deliberately that S2 pays for the rename. S3 (LDAP,
month 3) fits neither OAuth nor SAML shapes, so this is not a two-driver question.

Likewise `refreshPrincipal`: S1 should establish that a driver lacking a capability
throws `IdentityCapabilityError` rather than returning something empty. SAML will be
the first driver to use it, but the pattern belongs to whoever writes the interface.

## §PMO rulings (2026-09-02, #43 recon diff)
- Q-1: separate file server/endpoints/identity/saml.js (POST ACS, metadata endpoint); mounted in index.js after identity. inviteRateLimit on /sso/saml/acs from the first commit.
- Q-2: identity_assertion_ids sibling table (consume-not-delete, same purge); ONE migration slot 082000 for identity_providers + identity_assertion_ids.
- Q-3: S2 reads its config from identity_providers table; S1 stays env-only. Do not touch endpoints/identity.js providerConfig() in #43. Unifying OIDC onto the table → follow-up [→ needs issue].
- Q-4: yes — XSW fixtures first, library chosen against them.
- #36 close is PMO's step; do not run task.sh close.

### PMO rulings after Techlead review of 79448c01 (2026-09-02)
- Ruling: after the assertion-ID match, `doc` is out of scope. Every later read (NameID, Conditions, AudienceRestriction, SubjectConfirmationData/@InResponseTo, AttributeStatement) is relative to the verified `assertions[0]`. Techlead FINDING-1: a Subject in `<samlp:Extensions>` outside any Assertion passed every guard and won by document order.
- Ruling: fixture `xswUnwrappedSubject` required, RED before the fix (§7.9).
- Ruling: signing key comes from provider config only; KeyInfo/X509Certificate in the assertion is never used to verify. Test: self-signed assertion with matching KeyInfo → rejected.
- Ruling: store-side username is not normalized because the `^[a-z][a-z0-9._@-]*$` regex + Prisma insensitive already bound it; comment marks this as load-bearing.
- Ruling: `identity_links.email` NFC backfill goes into migration slot 082000 (no new slot).
- Ruling: exhausting 5 suffix candidates raises `IdentityUnavailableError`, not `IdentityConflictError`.
- Ruling: `AssertionReplay.claim` runs only after signature verify, ID-match and Conditions/Audience/InResponseTo all pass. Three tests count rows for signature-fail / expired / wrong-audience (no row); mutant moving claim to method head must kill all three.
- Ruling (driver acceptance, from Techlead dab75e1a review): all assertion reads go through `readFromAssertion(node, xpath)` which never sees `doc`; fixtures expired/notYetValid/wrongAudience/wrongInResponseTo each get an unwrapped-in-Extensions sibling; ACS order verify → issuer/audience/conditions → claim → linkPrincipal; claim `expiresAt` = `NotOnOrAfter` from the verified node; order-pinning test (broken-signature doc with victim ID, then real assertion must still succeed).
- Ruling: `identity_providers.id` gets `DEFAULT gen_random_uuid()` in slot 082000; `normalize()` needs PG13+ (stack is PG16, comment only); backfill adds `WHERE email <> normalize(email, NFC)`.
- Ruling (ACS acceptance, Techlead 01888688 review): `@Recipient` (signed, via readFromAssertion) must equal `acsUrl` before claim; `@Destination` is advisory early-reject only. `Assertion/Issuer` must equal `idpEntityId` before claim. `samlp:Status` logged (not returned) when no assertion. Comment that `_checkConditions`/`_checkAudience` carry each other's weight.
- Ruling (post-review 4765dbae, small follow-up commit before merge if fast, else follow-up issue): mount-order test with explanatory assertion (GET /api/sso/saml/login → 302, comment names the wildcard); `consumed.provider !== PROVIDER` check in both SAML and OIDC callback (one line each); `warnIfRecipientCheckDegraded` also validates the 4 mandatory SAML env vars at mount (NOTE-B). NOTE-A (SSO_ACS_URL vs SSO_CALLBACK_BASE_URL canonical) → residual.
