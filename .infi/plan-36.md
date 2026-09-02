# Plan — #36 S1 OIDC identity provider

Base: `approof/main` @ `c80905b0`. Branch `approof/s1-oidc`.
Scope after the R3 split: **OIDC only** — new files + schema + `index.js` mount.
Untouched: `endpoints/system.js`, `frontend/src/models/system.js`,
`models/systemSettings.js`, `utils/helpers/updateENV.js`,
`__tests__/ssoIssuanceLockHttp.test.js`, `actorResolver.js`,
`simpleSSOEnabled`/`simpleSSOLoginDisabled`.

## Task order (each RED before GREEN)

**T1 — schema + migration.** `identity_links`, `identity_login_state` inserted
after `temporary_auth_tokens` (schema.prisma:369), migrations `080000` /
`081000`. RED: a test asserting `@@unique([provider, subject])` rejects a second
row fails before the migration exists.

**T2 — errors module.** Five error classes, each with `retryable`. RED: import
fails.

**T3 — driver.** `OidcIdentityProvider`: discovery, PKCE `beginLogin`, JWKS
`completeLogin` verifying issuer/audience/signature/nonce/`email_verified`.
`capabilities()` returns directorySync/groupSync/deltaSync false;
`listPrincipals`/`listGroups` throw `IdentityCapabilityError`.

**T4 — registry.** `identityProviders/index.js`, the only import callers use.

**T5 — login state model.** Issue/consume `identity_login_state`;
single-use via `consumedAt`, replay distinguishable from expiry.

**T6 — linkPrincipal (core).** `ExternalPrincipal` → local user. R1 reject on
email collision, R2 `member` role, subject stability.

**T7 — routes.** `endpoints/identity.js`, mounted in `index.js` at the END of
both the import group and the mount group. Rate limiter per Q-4.

**T8 — retention.** Register `identity_login_state` with T-6's purge, TTL 15 min.

## Decisions to make in code, with reasons

**D-a. SSO users and `User.create`.** `User.create` (`models/user.js:111`)
requires a password passing `checkPasswordComplexity`, and hashes it. An SSO
user has no password. Options: pass a random high-entropy string (user can never
use it, but a password hash exists and local login is technically possible if
someone resets it), or write the row directly and call `syncLegacyRoleGrant`
myself. **Taking the random-secret route through `User.create`** — it keeps one
user-creation path, gets `syncLegacyRoleGrant` (R2) for free, and does not
duplicate validation. A directly-written row that skipped `syncLegacyRoleGrant`
would be a user the engine denies, which is exactly the T-4a bug class.

**D-b. Session issuance reuses `TemporaryAuthToken`.** Per the ruling: after
`linkPrincipal` resolves a user, mint a temp token and let the existing
`validate()` path produce the session JWT. No second session type.

**D-c. Client secret in `CredentialStore`, not `.env`.** Seam §Boundaries. Read
via `CredentialStore.get`. `codeVerifier` stays a column (recon §3 justifies it:
minutes-lived, single-use) and the PR says so out loud.

**D-d. `state` is the PK and must be unguessable.** 32 random bytes base64url,
same generator shape as `makeTempToken`.

## RED list (recon §4) — 10 cases

1 state replay · 2 nonce mismatch · 3 issuer/audience/signature (three separate
tests) · 4 unverified email · 5 linking conflict (asserted at the DB constraint)
· 6 subject stability · 7 provider unavailable → no session · 8 capability lie ·
9 HTTP end-to-end on real Postgres with `migrate deploy` · 10 `locals.user` set
and `resolveActor` yields `type: "user"`.

Plus, beyond the recon: **11** login-state rows are purged at TTL (Q-3), and
**12** the login route is rate limited (Q-4).
