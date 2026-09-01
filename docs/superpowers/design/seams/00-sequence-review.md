# Seam sequence review

These diagrams test contract composition. Boxes named `Core …` are orchestration only: they hold no provider logic and every external, policy, retrieval, delivery, or durable asynchronous interaction crosses a named seam. No channel, connector, or job reaches an implementation provider directly.

## 1. SSO login

```mermaid
sequenceDiagram
  actor User
  participant Web as Channel seam (Web)
  participant Login as Core login orchestration
  participant IdP as Identity provider seam (OIDC)
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Events as Event bus seam
  User->>Web: Start login
  Web->>Login: Canonical login request
  Login->>IdP: beginLogin(PKCE, state, nonce)
  IdP-->>Web: Authorization URL
  User->>Web: OIDC callback(code, state)
  Web->>Login: Verified callback transport
  Login->>IdP: completeLogin(code, state, nonce)
  IdP-->>Login: ExternalPrincipal
  Login->>License: activateSeat(userId, idempotencyKey)
  License-->>Login: Seat reserved
  Login->>Authz: authorize(session.create, user)
  Authz-->>Login: Allowed
  Login->>Events: publish(identity.login.succeeded)
  Login-->>Web: Local session
  Web-->>User: Authenticated response
```

Failure check: invalid IdP proof creates no user session; seat or authorization denial emits a sanitized failure event and fails closed.

## 2. Web chat through redaction, guardrail, and metering

```mermaid
sequenceDiagram
  actor User
  participant Web as Channel seam (Web)
  participant Pipeline as Chat pipeline seam
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Redact as Chat pipeline middleware (Redaction)
  participant Vector as Vector ACL seam
  participant Guard as Chat pipeline middleware (Guardrail)
  participant Meter as Chat pipeline middleware (Metering)
  participant Events as Event bus seam
  User->>Web: Send prompt
  Web->>Pipeline: run(CanonicalChatRequest)
  Pipeline->>Authz: authorize(chat.create, workspace)
  Authz-->>Pipeline: Allowed
  Pipeline->>License: checkFeature(chat)
  License-->>Pipeline: Entitled
  Pipeline->>Redact: handle(prompt)
  Redact-->>Pipeline: Redacted prompt
  Pipeline->>Authz: documentFilter(document.search)
  Authz-->>Pipeline: DocumentAclFilter
  Pipeline->>Vector: queryAuthorized(query, aclFilter)
  Vector-->>Pipeline: Authorized chunks only
  Pipeline->>Guard: handle(prompt + chunks)
  Guard-->>Pipeline: Guarded model request/output
  Pipeline->>Meter: handle(usage, requestId)
  Meter-->>Pipeline: Durable usage recorded
  Pipeline->>Events: publish(chat.completed)
  Pipeline-->>Web: Canonical guarded response
  Web-->>User: Deliver response
```

Failure check: redaction, ACL, guardrail, or metering failure stops delivery; streaming output crosses output guardrail before channel delivery.

## 3. Lark bot query

```mermaid
sequenceDiagram
  actor LarkUser
  participant Lark as Channel seam (Lark bot)
  participant Identity as Identity provider seam (Lark/OIDC binding)
  participant Pipeline as Chat pipeline seam
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Events as Event bus seam
  LarkUser->>Lark: Bot message webhook
  Lark->>Lark: receive(): verify signature + dedupe deliveryId
  Lark->>Identity: refreshPrincipal(external subject)
  Identity-->>Lark: Normalized principal
  Lark->>Authz: authorize(channel.use, binding)
  Authz-->>Lark: Allowed workspace binding
  Lark->>Pipeline: run(CanonicalChatRequest)
  Pipeline->>License: checkFeature(lark_bot)
  License-->>Pipeline: Entitled
  Pipeline->>Authz: authorize(chat.create, workspace)
  Authz-->>Pipeline: Allowed
  Pipeline->>Events: publish(chat.completed)
  Pipeline-->>Lark: Canonical response
  Lark-->>LarkUser: deliver(response, same deliveryId)
```

Failure check: delivery retry reuses stored canonical response; it never reruns pipeline or bills twice.

## 4. Connector sync with ACL mapping

```mermaid
sequenceDiagram
  participant Queue as Job queue seam
  participant Sync as Core sync orchestration
  participant Authz as Authorization engine seam
  participant Connector as Connector SDK seam
  participant Storage as Storage seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Queue->>Sync: claim(connector.sync, service actor)
  Sync->>Authz: authorize(connector.sync, connection)
  Authz-->>Sync: Allowed scope
  Sync->>Connector: listChanges(checkpoint, scope)
  Connector-->>Sync: Source documents + next checkpoint
  loop Each changed source document
    Sync->>Connector: fetchContent(sourceId)
    Connector-->>Sync: Content stream + etag
    Sync->>Connector: fetchAcl(sourceId)
    Connector-->>Sync: SourceAcl external IDs
    Sync->>Authz: authorize(connector.acl.map, document)
    Authz-->>Sync: Allowed local mapping scope
    Sync->>Storage: put(tenant-scoped document key)
    Storage-->>Sync: StoredObject checksum
    Sync->>Vector: upsertDocument(chunks, documentId, hidden=false)
    Vector-->>Sync: Vector IDs
    Sync->>Events: publish(document.synced + mapped ACL)
  end
  Sync->>Queue: complete(job) after checkpoint transaction
```

Failure check: unknown ACL principal maps to no access. Checkpoint advances only after content, local ACL, vectors, and outbox state are durable.

## 5. Organization document search with ACL filter

```mermaid
sequenceDiagram
  actor User
  participant Web as Channel seam (Web search)
  participant Search as Core search orchestration
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  User->>Web: Search query + filters
  Web->>Search: Canonical search request
  Search->>License: checkFeature(org_search)
  License-->>Search: Entitled
  Search->>Authz: authorize(document.search, org)
  Authz-->>Search: Allowed
  Search->>Authz: documentFilter(actor, all allowed workspaces)
  Authz-->>Search: DocumentAclFilter(policyVersion)
  Search->>Vector: queryAuthorized(query, aclFilter, metadataFilters)
  Vector-->>Search: Authorized, visible hits only
  Search->>Events: publish(document.search.completed)
  Search-->>Web: Search results
  Web-->>User: Render files and locations
```

Failure check: missing/unsupported ACL filter produces no search. Admin identity gets no implicit bypass.

## 6. Retention purge job

```mermaid
sequenceDiagram
  participant Queue as Job queue seam
  participant Purge as Core retention orchestration
  participant Authz as Authorization engine seam
  participant Storage as Storage seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Queue->>Purge: claim(retention.purge, service actor)
  Purge->>Authz: authorize(retention.purge, policy scope)
  Authz-->>Purge: Allowed
  loop Each expired object
    Purge->>Vector: setDocumentVisibility(hidden=true)
    Vector-->>Purge: Hidden from new queries
    Purge->>Storage: delete(tenant-scoped key)
    Storage-->>Purge: Deleted/idempotent missing
    Purge->>Vector: deleteDocument(documentId)
    Vector-->>Purge: Deleted count
    Purge->>Events: publish(retention.object.purged)
  end
  Purge->>Queue: complete(job)
```

Failure check: hide happens before physical deletion. Crash may replay; storage/vector deletes and event IDs are idempotent.

## 7. License seat check and activation

```mermaid
sequenceDiagram
  actor Admin
  participant Web as Channel seam (Web admin)
  participant Lifecycle as Core user lifecycle orchestration
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Notify as Notification seam
  participant Events as Event bus seam
  Admin->>Web: Activate user
  Web->>Lifecycle: Canonical activation request
  Lifecycle->>Authz: authorize(user.activate, target user)
  Authz-->>Lifecycle: Allowed
  Lifecycle->>License: verify(signed offline license)
  License-->>Lifecycle: Valid snapshot
  Lifecycle->>License: activateSeat(userId, idempotencyKey)
  alt Seat available
    License-->>Lifecycle: Atomic seat reservation
    Lifecycle->>Events: publish(user.activated)
    Lifecycle->>Notify: send(activation notification)
    Lifecycle-->>Web: Activated
  else Limit exceeded
    License-->>Lifecycle: SeatLimitExceededError
    Lifecycle->>Events: publish(license.seat.denied)
    Lifecycle-->>Web: Denied without user activation
  end
```

Failure check: concurrent activation cannot exceed signed seat limit; offline verification never calls home.

## 8. Audit event flow

```mermaid
sequenceDiagram
  participant Source as Any named seam
  participant Events as Event bus seam
  participant Audit as Event bus subscriber (Audit)
  participant Notify as Notification seam
  Source->>Events: publish(versioned sanitized event in outbox transaction)
  Events-->>Source: Durable acceptance
  Events->>Audit: deliver(eventId), at least once
  Audit->>Audit: Append once by subscriberId + eventId
  Audit->>Events: acknowledge(eventId)
  opt Critical operational event
    Events->>Notify: deliver notification subscriber work
    Notify-->>Events: Accepted deliveryId
  end
```

Failure check: subscriber failure retries/dead-letters independently; business mutation and audit event cannot commit separately.

## 9. Offboarding and ownership transfer

```mermaid
sequenceDiagram
  actor Admin
  participant Web as Channel seam (Web admin)
  participant Lifecycle as Core user lifecycle orchestration
  participant Authz as Authorization engine seam
  participant Queue as Job queue seam
  participant License as License gate seam
  participant Storage as Storage seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Admin->>Web: Deactivate user + choose new owner
  Web->>Lifecycle: Canonical offboarding request
  Lifecycle->>Authz: authorize(user.deactivate + ownership.transfer)
  Authz-->>Lifecycle: Allowed for both actions
  Lifecycle->>Queue: enqueue(offboarding.transfer, explicit actor)
  Queue->>Lifecycle: claim(job)
  Lifecycle->>Authz: authorize again at execution
  Authz-->>Lifecycle: Allowed under current policy
  Lifecycle->>Storage: copy user-owned generated/export blobs to new typed keys
  Storage-->>Lifecycle: StoredObjects
  Lifecycle->>Vector: setDocumentVisibility(documentId, hidden during ACL handoff)
  Lifecycle->>Authz: authorize(document.ownership.assign, new owner)
  Authz-->>Lifecycle: Allowed
  Lifecycle->>Vector: setDocumentVisibility(documentId, visible after handoff)
  Lifecycle->>License: releaseSeat(userId, idempotencyKey)
  Lifecycle->>Events: publish(user.offboarded + ownership.transferred)
  Lifecycle->>Queue: complete(job)
```

Failure check: source ownership remains until destination copy and metadata/ACL transfer commit; failed job retries without freeing seat early or exposing document mid-handoff.

## 10. Emergency content hide

```mermaid
sequenceDiagram
  actor Moderator
  participant Web as Channel seam (Web admin)
  participant Hide as Core moderation orchestration
  participant Authz as Authorization engine seam
  participant Vector as Vector ACL seam
  participant Queue as Job queue seam
  participant Events as Event bus seam
  participant Notify as Notification seam
  Moderator->>Web: Hide document or connector
  Web->>Hide: Canonical hide request
  Hide->>Authz: authorize(content.emergency_hide, target)
  Authz-->>Hide: Allowed sensitive-content moderator
  Hide->>Vector: setDocumentVisibility(hidden=true)
  Vector-->>Hide: Hidden before return
  Hide->>Events: publish(content.emergency_hidden)
  Hide->>Queue: enqueue(content.cleanup/reindex, service actor)
  Hide->>Notify: send(security moderator alert)
  Hide-->>Web: Containment confirmed
  Web-->>Moderator: Hidden immediately
```

Failure check: success is returned only after new vector queries exclude target. Cleanup/reindex is asynchronous and cannot re-enable visibility.

## Review result

All ten use cases cross named seams for provider I/O, policy decisions, chat execution, retrieval, durable asynchronous work, events, notifications, licensing, and blob access. Contracts needed three explicit composition rules found while drawing: channel delivery retries do not rerun chat; connector checkpoints wait for ACL/index durability; emergency hide is synchronous at vector query layer.
