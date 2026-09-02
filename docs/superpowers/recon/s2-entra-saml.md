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
