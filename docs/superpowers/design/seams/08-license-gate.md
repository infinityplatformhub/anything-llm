# License gate seam

## Responsibility

Provide one offline-capable entitlement and active-seat decision point for feature use, activation, and user lifecycle. Authorization answers “may actor do this”; license gate separately answers “has deployment purchased capacity/feature.”

## Driver contract

```js
/** @typedef {{status:"valid"|"grace"|"expired"|"invalid", edition:string, expiresAt:Date|null, seatLimit:number, features:string[], verifiedAt:Date}} LicenseSnapshot */
/** @typedef {{allowed:boolean, code:string, snapshot:LicenseSnapshot}} EntitlementDecision */
/** @interface LicenseGateDriver */
class LicenseGateDriver {
  /** @param {{licenseKey:string, deploymentId:string, now:Date}} input @returns {Promise<LicenseSnapshot>} */
  async verify(input) {}
  /** @param {{feature:string, actorId?:string, workspaceId?:string, now:Date}} input @returns {Promise<EntitlementDecision>} */
  async checkFeature(input) {}
  /** Atomic seat reservation. @param {{userId:string, idempotencyKey:string, now:Date}} input @returns {Promise<{activeSeats:number, seatLimit:number}>} */
  async activateSeat(input) {}
  /** @param {{userId:string, idempotencyKey:string, now:Date}} input @returns {Promise<{activeSeats:number, seatLimit:number}>} */
  async releaseSeat(input) {}
  /** @returns {Promise<{activeSeats:number, seatLimit:number, users:string[]}>} */
  async seatUsage() {}
}
module.exports = { LicenseGateDriver };
```

Signed license verification uses pinned vendor public key and deployment binding without network. Seat mutation and user activation/deactivation commit atomically or through one durable transaction boundary.

## First driver

`SignedPerSeatLicenseGate`: local signed license file/key, active local users as seats, configurable grace period encoded in signed claims.

## Boundaries

- Driver MUST NOT grant permissions, create/deactivate users, call home, or silently modify seat count.
- Driver MUST NOT trust wall-clock data from clients or unsigned license fields.
- Feature callers MUST use this seam; scattered edition/env checks are forbidden.
- Service accounts/background jobs do not consume seats unless license claims explicitly say so, but still require feature entitlement.
- Cached snapshots MUST preserve expiry enforcement and signature/deployment binding.

## Failure semantics

Invalid signature/deployment binding throws non-retryable `LicenseInvalidError` and denies licensed operations. Expiry follows signed grace policy; afterward denies with `LicenseExpiredError`. Atomic activation over limit throws `SeatLimitExceededError`; concurrent activation cannot oversubscribe. Duplicate activate/release keys return prior outcome. Corrupt/unreadable license fails closed but leaves recovery/admin license replacement available. No network failure can invalidate an otherwise valid offline license.
