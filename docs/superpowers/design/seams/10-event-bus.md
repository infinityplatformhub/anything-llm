# Internal event bus seam

## Responsibility

Publish durable, versioned domain events and deliver them to independent subscribers. Audit log is first subscriber; notifications, metrics, webhook/SIEM sinks, and operational workflows consume same sanitized facts.

## Driver contract

```js
/** @typedef {{eventId:string, type:string, version:number, occurredAt:Date, actor:{type:"user"|"service"|"system", id:string|null, orgId:string}, resource:{type:string, id:string|null, workspaceId?:string}, traceId:string, data:Object, sensitivity:"metadata"|"content"}} DomainEvent */
/** @interface EventBusDriver */
class EventBusDriver {
  /** Publish durably; transaction/outbox option binds model mutation and event. @param {{event:DomainEvent, transaction?:Object}} input @returns {Promise<void>} */
  async publish(input) {}
  /** @param {{subscriberId:string, eventTypes:string[], handler:(event:DomainEvent)=>Promise<void>, maxAttempts?:number}} input @returns {Promise<()=>Promise<void>>} */
  async subscribe(input) {}
  /** @param {{subscriberId:string, eventId:string}} input @returns {Promise<void>} */
  async acknowledge(input) {}
  /** Controlled replay, same event IDs. @param {{subscriberId:string, from:Date, to?:Date, eventTypes?:string[]}} input @returns {Promise<{queued:number}>} */
  async replay(input) {}
}
module.exports = { EventBusDriver };
```

Event schemas are immutable per version. Common envelope always carries actor/resource/trace identity. Secret scrub and content classification occur before durable publication. Delivery is at least once; subscribers deduplicate by `subscriberId + eventId`.

## First driver

`PostgresEventBus` using transactional outbox; `AuditEventSubscriber` writes append-only `event_logs` first.

## Boundaries

- Bus MUST NOT implement audit retention, notification policy, webhooks, or subscriber business logic.
- Publishers MUST NOT write audit records directly or publish credentials, tokens, raw redacted input, or connector secrets.
- Subscriber failure MUST NOT roll back committed business mutation or block unrelated subscribers.
- Consumers MUST NOT mutate/relabel original event; derived facts publish new linked events.
- Content-level compliance events require explicit `sensitivity:"content"` and separate authorization/retention.

## Failure semantics

Mutation requiring audit must commit event in same DB transaction/outbox; inability to persist both fails operation. Duplicate `eventId` is idempotent only when payload hash matches; mismatch throws `EventConflictError`. Subscriber failure retries independently, then dead-letters and emits operational failure without recursive audit loops. Unknown event version is quarantined, not guessed. Ordering is guaranteed per resource aggregate where declared, not globally. Replay preserves IDs/timestamps and does not duplicate idempotent audit rows.
