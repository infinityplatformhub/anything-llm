# License gate seam

## Responsibility

Provide one offline-capable entitlement, active-seat, and usage-budget decision point for feature use, activation, user lifecycle, and enforceable global/group/user/workspace/embed-key ceilings. Authorization answers “may actor do this”; license gate separately answers “has deployment purchased capacity/feature.”

## Driver contract

```js
/** @typedef {{status:"valid"|"grace"|"expired"|"invalid", edition:string, expiresAt:Date|null, seatLimit:number, features:string[], verifiedAt:Date}} LicenseSnapshot */
/** @typedef {{allowed:boolean, code:string, snapshot:LicenseSnapshot}} EntitlementDecision */
/** @typedef {{scopeType:"global"|"group"|"user"|"workspace"|"embed-key", scopeId:string, limit:number, consumed:number, reserved:number, remaining:number, resetsAt:Date|null, unit:"tokens"|"cost-micros"}} BudgetDecision */
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
  /** Strictest applicable scope wins. @param {{actor:Object, workspaceId:string, model:string, estimatedUsage:Object, now:Date}} input @returns {Promise<{allowed:boolean, budgets:BudgetDecision[], reservationId:string|null}>} */
  async checkBudget(input) {}
  /** Atomic incremental/final consumption; same idempotency key is safe. @param {{reservationId:string|null, actor:Object, workspaceId:string, usage:Object, idempotencyKey:string, final:boolean, now:Date}} input @returns {Promise<{allowed:boolean, budgets:BudgetDecision[], exhaustedScope?:Object}>} */
  async consumeBudget(input) {}
}
module.exports = { LicenseGateDriver };
```

Signed license verification uses pinned vendor public key and deployment binding without network. Seat mutation and user activation/deactivation commit atomically or through one durable transaction boundary.

## First driver

`SignedPerSeatLicenseGate`: local signed license file/key, active local users as seats, configurable grace period encoded in signed claims, and Postgres-backed atomic budget counters/reservations.

## Boundaries

- Driver MUST NOT grant permissions, create/deactivate users, call home, or silently modify seat count.
- Driver MUST NOT trust wall-clock data from clients or unsigned license fields.
- Feature callers MUST use this seam; scattered edition/env checks are forbidden.
- Service accounts/background jobs and `embed` scoped-key actors do not consume seats unless signed license claims explicitly say so, but still require feature entitlement and budgets. Embed usage is charged to strictest `embed-key`, workspace, and global budget—not a fabricated user.
- Usage middleware owns budget read/consume calls; callers MUST NOT update counters directly. Strictest applicable global/group/user/workspace/embed-key ceiling wins.
- Cached snapshots MUST preserve expiry enforcement and signature/deployment binding.

## Failure semantics

Invalid signature/deployment binding throws non-retryable `LicenseInvalidError` and denies licensed operations. Expiry follows signed grace policy; afterward denies with `LicenseExpiredError`. Atomic activation over limit throws `SeatLimitExceededError`; concurrent activation cannot oversubscribe. Duplicate activate/release keys return prior outcome. Corrupt/unreadable license fails closed but leaves recovery/admin license replacement available. No network failure can invalidate an otherwise valid offline license. Budget reservation/consumption is atomic under concurrency and idempotent per request/chunk. Counter-store failure fails closed before or during stream; exhaustion returns `allowed:false`, causing chat pipeline to abort immediately while retaining already consumed usage. Final reconciliation releases unused reservation but never refunds provider-reported usage.
