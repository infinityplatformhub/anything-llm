# Identity provider seam

## Responsibility

Authenticate an external identity, normalize it into a provider-neutral principal, and manage provider-originated login and logout. Core owns user linking, session creation, domain policy, role assignment, and audit emission.

## Driver contract

Drivers follow existing CommonJS provider classes: constructor validates configuration, `className` identifies logs, static methods expose setup metadata, and instance methods perform provider I/O.

```js
/** @typedef {{value:string, expiresAt:Date|null}} IdentityState */
/** @typedef {{provider:string, subject:string, email:string, emailVerified:boolean, displayName:string|null, groups:string[], claims:Object}} ExternalPrincipal */
/** @typedef {{authorizationUrl:string, state:IdentityState}} LoginChallenge */
/** @typedef {{directorySync:boolean, groupSync:boolean, deltaSync:boolean}} IdentityCapabilities */
/** @typedef {{provider:string, subject:string, email:string, active:boolean, displayName:string|null, groupExternalIds:string[], revision:string|null}} DirectoryPrincipal */
/** @typedef {{externalId:string, name:string, memberExternalIds:string[], revision:string|null}} DirectoryGroup */
/**
 * @interface IdentityProviderDriver
 */
class IdentityProviderDriver {
  /** @returns {string} Stable provider key. */
  static providerId() {}
  /** Capability flags; unsupported methods MUST NOT be called. @returns {IdentityCapabilities} */
  static capabilities() {}
  /** @returns {Promise<{ok:boolean, details:Object}>} */
  static async validateConnection(_config) {}
  /** @param {{redirectUri:string, state:string, nonce:string}} input @returns {Promise<LoginChallenge>} */
  async beginLogin(input) {}
  /** @param {{redirectUri:string, code:string, state:string, expectedNonce:string}} input @returns {Promise<ExternalPrincipal>} */
  async completeLogin(input) {}
  /** @param {{subject:string, refreshToken?:string}} input @returns {Promise<ExternalPrincipal>} */
  async refreshPrincipal(input) {}
  /** @param {{subject:string, sessionId:string}} input @returns {Promise<void>} */
  async revokeSession(input) {}
  /** Requires directorySync. @param {{cursor:string|null, delta:boolean, limit:number, signal:AbortSignal}} input @returns {Promise<{principals:DirectoryPrincipal[], nextCursor:string|null, hasMore:boolean}>} */
  async listPrincipals(input) {}
  /** Requires groupSync. @param {{cursor:string|null, delta:boolean, limit:number, signal:AbortSignal}} input @returns {Promise<{groups:DirectoryGroup[], nextCursor:string|null, hasMore:boolean}>} */
  async listGroups(input) {}
}
module.exports = { IdentityProviderDriver };
```

`state` and `nonce` validation is mandatory and single-use. `provider + subject`, not email, is stable external identity.

## First driver

`OidcIdentityProvider`: generic Authorization Code + PKCE driver for Google, Entra, and Lark-compatible OIDC discovery; its default capabilities set directory/group sync false. `LarkIdentityProvider` is first directory-capable driver for S4 org sync and S12 offboarding. Core applies email-domain policy after normalization.

## Boundaries

- Driver MUST NOT create/update local users, issue app sessions/JWTs, grant roles, or decide workspace membership.
- Driver MUST NOT trust unverified email/group claims or bypass core domain and license checks.
- Secrets and refresh tokens MUST use credential storage; driver must not persist plaintext.
- Callback route MUST call this seam; no provider-specific callback may create a session directly.
- Directory results are observations only. Core reconciler maps principals/groups, authorizes membership changes, deactivates missing/tombstoned users, and owns sync checkpoints.
- A driver advertising a false capability MUST throw `IdentityCapabilityError` if its corresponding optional method is called; core must not emulate directory sync from login activity.

## Failure semantics

Configuration/discovery failure throws `IdentityConfigurationError` and fails closed. Invalid/replayed state, nonce, signature, issuer, audience, or unverified required email throws `IdentityAuthenticationError`; caller returns a generic authentication failure without provider details. Provider timeout/unavailability throws retryable `IdentityUnavailableError`; no local session is created. Account linking conflict throws non-retryable `IdentityConflictError` and requires admin resolution. Revocation is idempotent; unknown remote session succeeds. Directory page/checkpoint replay is idempotent. Invalid directory records are quarantined without widening membership; a partial/failed enumeration MUST NOT be interpreted as users having left. Deactivation occurs only from an authoritative tombstone or completed full snapshot.
