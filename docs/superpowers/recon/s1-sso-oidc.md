# S1 recon — OIDC identity provider

Lane B, month 2. Base `approof/main` @ `bbf3b7ed`. Seam: `docs/superpowers/design/seams/01-identity-provider.md`.

Depends on P0-5 only through `actorResolver` rows 4/5, which are merged. **Does not block on T-5/T-7.**

## 0. What exists today, and why it is the thing being replaced

`GET /request-token/sso/simple` (`server/endpoints/system.js:361`) exchanges a `temporary_auth_tokens` row for a session JWT. Tokens are minted by `GET /v1/users/:id/issue-auth-token`, which any API key could call for any user — full admin impersonation. That is issue #8; `ssoIssuanceLock` closes the endpoint unless `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` is set, and the middleware's own docblock says it is removed once `sso.issue` scope enforcement lands (which PR-4a did).

So S1 inherits three things:

1. **A working session-issuance path** (`TemporaryAuthToken.validate` → `sessionToken`) that the OIDC callback can reuse. Do not build a second one.
2. **A lock that should come off, but not silently.** `ssoIssuanceLock` + `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` exist because the mint endpoint was unscoped. PR-4a gave it `sso.issue`. Decide explicitly in S1 whether simple-SSO stays as a second provider or is deleted — leaving it locked forever is a third state nobody owns.
3. **`temporary_auth_tokens` has no provider column.** It is `token / userId / expiresAt` only. OIDC state/nonce cannot live there without a schema change (§3).

## 1. Owner files

**New**
- `server/utils/identityProviders/OidcIdentityProvider/index.js` — the driver. Authorization Code + PKCE, discovery document, JWKS verification.
- `server/utils/identityProviders/index.js` — registry + wired singleton, the only thing callers import (code-standards §5).
- `server/utils/identityProviders/errors.js` — `IdentityConfigurationError`, `IdentityAuthenticationError`, `IdentityUnavailableError`, `IdentityConflictError`, `IdentityCapabilityError`. Seam §"Failure semantics" names all five; they are the contract, not conveniences.
- `server/endpoints/identity.js` — `GET /sso/:provider/login`, `GET /sso/:provider/callback`.
- `server/utils/identity/linkPrincipal.js` — **core**, not driver: maps `ExternalPrincipal` → local user row, applies domain policy, assigns role.
- Tests under `server/__tests__/security/identity/`.

**Modified**
- `server/prisma/schema.prisma` — `identity_links`, `identity_login_state` (§3).
- `server/endpoints/system.js` — mount the new routes; decide simple-SSO's fate.

**Not touched:** `actorResolver.js`. OIDC ends at `locals.user` like every other user ingress (row 4/5, `actorResolver.js:51-70`), so the resolver already handles it. **If S1 finds itself editing the resolver, something is wrong** — that is the single Actor construction site and three tracks already queued behind it.

## 2. The boundary that will be violated first

Seam §Boundaries: *"Driver MUST NOT create/update local users, issue app sessions/JWTs, grant roles, or decide workspace membership."*

The tempting shape is a driver that returns a session. Do not. `completeLogin()` returns an `ExternalPrincipal` — provider, subject, email, emailVerified, displayName, groups, claims — and **core** decides whether that principal becomes a user. The reason is not purity: S2 (SAML) and S3 (LDAP) land in month 3 against the same core, and a driver that mints sessions means three implementations of domain policy, three places role assignment can drift.

`provider + subject` is identity, **never email**. Email changes; subject does not. A user linked by email is a takeover waiting for someone to change their address at the IdP.

## 3. Migration

Slot: next free hour. `043000` is taken (PR-4b(4)); PR-4c holds `045000`, T-6 holds `050000`. **S1 takes `060000`** — month 2 work starting a new decade keeps Phase 0's slots readable as a block. Claim on branch open.

```prisma
model identity_links {
  id           Int      @id @default(autoincrement())
  userId       Int
  provider     String
  subject      String
  email        String
  lastLoginAt  DateTime? @db.Timestamptz(3)
  createdAt    DateTime @default(now()) @db.Timestamptz(3)
  user         users    @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([provider, subject])
  @@index([userId])
}

model identity_login_state {
  state       String   @id
  nonce       String
  provider    String
  redirectUri String
  codeVerifier String
  expiresAt   DateTime @db.Timestamptz(3)
  consumedAt  DateTime? @db.Timestamptz(3)
}
```

Three notes:
- `@@unique([provider, subject])` is what makes account linking a database constraint rather than application logic. Two users linking the same IdP identity must fail at the write.
- `consumedAt`, not deletion — seam requires state and nonce be **single-use**, and a consumed row that still exists is how a replay is detected rather than mistaken for an expired one.
- All timestamps `Timestamptz(3)` per code-standards §1.1.

`codeVerifier` is a PKCE secret at rest. It is short-lived (minutes) and single-use, which is why it may sit in this table rather than credential storage — but say so in the PR, because "secret in a plain column" is the correct thing to challenge. The client secret is different: it goes through credential storage, never `.env` echoed by `update-env` (see the residual note about URL-valued env keys carrying `user:pass@`).

## 4. RED DoD

Each must fail before the driver exists.

1. **state replay** — complete a callback, then replay the same `state`. Second attempt throws `IdentityAuthenticationError` and creates no session. Assert `consumedAt` was already set, so the failure is "replayed", not "expired".
2. **nonce mismatch** — an ID token whose `nonce` differs from the stored one is rejected. This is the check that stops a token minted for another session being replayed into this one.
3. **issuer / audience / signature** — three separate cases, each rejected, each with no session created. Do not fold them into one test; they fail for different reasons and a single test passes when only one check exists.
4. **unverified email** — `email_verified: false` throws. An IdP that does not verify email cannot be allowed to assert one, or domain policy is bypassed by anyone who can type an address.
5. **linking conflict** — user A is linked to `(provider, subject)`; user B attempts to link the same pair → `IdentityConflictError`, non-retryable, no row written. Assert at the DB level, not just the branch.
6. **subject stability** — same subject, changed email → the *same* local user, email updated. Changed subject, same email → a **different** user (or a conflict, per the ruling below), never a silent takeover.
7. **provider unavailable** — discovery times out → `IdentityUnavailableError`, retryable, **no local session**. A provider being down must not degrade to a local login.
8. **capability lie** — a driver advertising `directorySync: false` whose `listPrincipals()` is called throws `IdentityCapabilityError`. Seam §Boundaries requires this explicitly; without the test the flag is decoration.
9. **HTTP end to end** — `GET /sso/oidc/login` returns a 302 to the IdP with `state` and `code_challenge`; the callback with a stubbed token endpoint returns a session JWT that `validatedRequest` accepts. Real Postgres, `migrate deploy` (code-standards §7.1a — `db push` skips the T-1 seed and every authorization assertion after it is meaningless).
10. **`locals.user` is set, nothing else** — assert the callback populates `locals.user` and that `resolveActor` yields a `type: "user"` actor with the right `workspaceIds`. This is the §7.5 rule: S1 adds an ingress, so it tests the contract that ingress writes.

## 5. Rulings needed before the issue opens

**R1 — a new external identity whose email matches an existing local user: link, or refuse?** Auto-linking is convenient and is also the classic takeover: anyone who can register that email at the IdP inherits the account. Recommend **refuse** (`IdentityConflictError`, admin resolves), with auto-link available behind an explicit `SSO_AUTO_LINK_VERIFIED_EMAIL` flag for deployments that own their IdP domain. Whatever is chosen, it is a stated ruling, not a default that emerges from the code.

**R2 — what role does a first-time SSO user get?** T-1 seeds `member` at org scope. Recommend `member`, with no group→role mapping in S1 at all: that is S4's job, and doing it here means two implementations. State it, because "the IdP said they are an admin" is exactly the claim a driver must not be trusted with.

**R3 — simple-SSO's fate** (§0 item 2). Recommend deleting `/request-token/sso/simple`, `ssoIssuanceLock`, and `SIMPLE_SSO_ISSUE_UNSAFE_ALLOW` in the same PR that lands OIDC, since `sso.issue` now scopes the mint endpoint and OIDC replaces the use case. If it stays, it needs an owner and a reason written down.

## 6. Collision

- **T-5** (`utils/chats/**`, vector drivers) — none.
- **T-7** (admin duties, new files) — none, unless T-7 adds an identity settings page; coordinate the settings route only.
- **S13 MFA** (lane B, right after S1) — will wrap the same login path. S1 should leave `linkPrincipal.js` as the single place a session is created, so S13 inserts one step rather than forking the flow.
- **S4 Lark org sync** (month 3) — reuses this seam's `listPrincipals`/`listGroups`. S1 must not implement them; advertising `directorySync: false` and throwing is the correct S1 behaviour.

## 7. Estimate

Driver + core linking + routes + 10 RED tests ≈ 4–5d. The driver itself is the small half; R1's linking policy and the state/nonce lifecycle are where the time goes.

## §PMO rulings
- R1: external identity whose email matches an existing local user → REJECT with an explicit "link from settings while logged in" flow (no auto-link; takeover class).
- R2: first-login SSO user gets `member` grant via legacyRoleGrants sync; no group→role mapping here (S4).
- R3: simple-SSO + ssoIssuanceLock + SIMPLE_SSO_ISSUE_UNSAFE_ALLOW are DELETED in S1 (PR-4a scope `sso.issue` covers the mint path); tests for the lock become tests for the scope.
- Do not touch actorResolver.js. Slot 060000. After T-4a merges (endpoints/system.js ownership).
- (2026-09-02, supersedes above) Owner: Dev3. Base: approof/main 893516f1. Slots 080000 identity_links / 081000 login_state (060000 taken by credential_store; t7 takes 070000/071000).
- Schema: insert identity models next to `temporary_auth_tokens` (schema.prisma ~359-369), NOT at end of file (t7 appends there).
- Routes: new `server/endpoints/identity.js` mounted in `server/index.js` like adminAuthorizationEndpoints; do NOT touch endpoints/system.js except the R3 deletion.
- index.js import/call go at END of their groups; final rebase after t7 merges.
- No frontend/src/models/system.js edits (reserved t7).
