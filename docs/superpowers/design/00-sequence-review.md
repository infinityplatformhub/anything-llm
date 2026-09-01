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
  participant Budget as License gate seam (Budget counters)
  participant Events as Event bus seam
  User->>Web: Send prompt
  Web->>Pipeline: run(CanonicalChatRequest)
  Pipeline->>Authz: authorize(chat.create, workspace)
  Authz-->>Pipeline: Allowed
  Pipeline->>License: checkFeature(chat)
  License-->>Pipeline: Entitled
  Pipeline->>Budget: checkBudget(actor, workspace, estimate)
  Budget-->>Pipeline: Allowed + reservationId
  Pipeline->>Redact: handle(prompt)
  Redact-->>Pipeline: Redacted prompt
  Pipeline->>Authz: documentFilter(document.search)
  Authz-->>Pipeline: DocumentAclFilter
  Pipeline->>Vector: queryAuthorized(query, aclFilter)
  Vector-->>Pipeline: Authorized chunks only
  Pipeline->>Guard: handle(prompt + chunks)
  Guard-->>Pipeline: Guarded model request
  loop Every model chunk before channel delivery
    Pipeline->>Guard: handleChunk(chunk, abort)
    Guard-->>Pipeline: continue/stop
    Pipeline->>Meter: handleChunk(known usage, abort)
    Meter->>Budget: consumeBudget(reservationId, delta)
    Budget-->>Meter: continue/exhausted
  end
  Pipeline->>Meter: handle(final usage, requestId)
  Meter->>Budget: consumeBudget(final reconciliation)
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
    Sync->>Vector: upsertDocument(namespace, chunks, documentId, workspaceId, hidden=false)
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

## 11. Lark directory sync and auto-deactivation

```mermaid
sequenceDiagram
  participant Queue as Job queue seam
  participant Reconcile as Core directory reconciliation
  participant IdP as Identity provider seam (Lark directory)
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Events as Event bus seam
  Queue->>Reconcile: claim(identity.directory.sync, service actor)
  Reconcile->>Authz: authorize(identity.directory.sync, org)
  Authz-->>Reconcile: Allowed
  Reconcile->>IdP: listPrincipals(cursor, delta=true)
  IdP-->>Reconcile: Active/tombstoned principals + cursor
  Reconcile->>IdP: listGroups(cursor, delta=true)
  IdP-->>Reconcile: Groups and memberships
  loop Each authoritative departure
    Reconcile->>Authz: authorize(user.deactivate, mapped user)
    Authz-->>Reconcile: Allowed
    Reconcile->>License: releaseSeat(userId, idempotencyKey)
    Reconcile->>Events: publish(identity.directory.user.deactivated)
  end
  Reconcile->>Queue: complete after reconciliation checkpoint commits
```

Failure check: partial enumeration never means departure. Only tombstone or completed authoritative full snapshot deactivates; OIDC-only capability flags prevent fake login-driven sync.

## 12. Connector ACL revocation propagation

```mermaid
sequenceDiagram
  participant Queue as Job queue seam
  participant Sync as Core ACL reconciliation
  participant Connector as Connector SDK seam
  participant Authz as Authorization engine seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Queue->>Sync: claim(connector.acl.sync, service actor)
  Sync->>Authz: authorize(connector.sync, connection)
  Authz-->>Sync: Allowed
  alt Driver supports ACL delta
    Sync->>Connector: listAclChanges(aclCheckpoint)
    Connector-->>Sync: sourceId + aclRevision changes
  else No ACL delta capability
    Sync->>Connector: full live-document enumeration (at least daily)
    Connector-->>Sync: All sourceIds + aclRevision where available
  end
  loop Each ACL candidate, content etag may be unchanged
    Sync->>Connector: fetchAcl(sourceId)
    Connector-->>Sync: Current SourceAcl
    Sync->>Authz: authorize(connector.acl.map, document)
    Authz-->>Sync: Mapping permission
    Sync->>Vector: setDocumentVisibility(hidden=true during ACL commit)
    Sync->>Events: publish(document.acl.changed)
    Sync->>Vector: setDocumentVisibility(hidden=false after safe mapping)
  end
  Sync->>Queue: complete after ACL checkpoint commits
```

Failure check: permission removal need not change content etag. Mapping/fetch failure leaves target hidden; stale grants never remain fallback.

## 13. Embed widget query

```mermaid
sequenceDiagram
  actor Visitor as Anonymous visitor
  participant Embed as Channel seam (Embed widget)
  participant Pipeline as Chat pipeline seam
  participant Authz as Authorization engine seam
  participant License as License gate seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Visitor->>Embed: Prompt + scoped embed key
  Embed->>Embed: Verify key; normalize embed actor
  Embed->>Pipeline: run(request with actor.type=embed)
  Pipeline->>License: checkFeature(embed_widget)
  License-->>Pipeline: Entitled; no seat consumed
  Pipeline->>License: checkBudget(embed-key + workspace + global)
  License-->>Pipeline: Allowed + reservation
  Pipeline->>Authz: authorize(chat.create, key-scoped workspace)
  Authz-->>Pipeline: Allowed only within key claims
  Pipeline->>Authz: documentFilter(embed actor)
  Authz-->>Pipeline: Attribute/bounded-key ACL filter, no groups
  Pipeline->>Vector: queryAuthorized(namespaces, aclFilter)
  Vector-->>Pipeline: Key-scoped authorized chunks
  Pipeline->>Events: publish(chat.completed, embed actor + scopedKeyId)
  Pipeline-->>Embed: Guarded metered response
  Embed-->>Visitor: Deliver
```

Failure check: URL/body scope can only narrow signed key claims. Missing scope yields `matchNone`; anonymous actor inherits no user/group access and consumes no seat.

## 14. View-as-user read and audit

```mermaid
sequenceDiagram
  actor Admin
  participant Web as Channel seam (Web admin)
  participant View as Core view-as-user orchestration
  participant Authz as Authorization engine seam
  participant Vector as Vector ACL seam
  participant Events as Event bus seam
  Admin->>Web: Start view-as target user
  Web->>View: Admin session + target
  View->>Authz: explainAccess(admin, target resource)
  Authz-->>View: Principals + matched policies + policyVersion
  View->>Authz: authorize(user.impersonate.read, target)
  Authz-->>View: Allowed
  View-->>Web: Read-only actor(onBehalfOf target, impersonatedBy admin)
  Admin->>Web: Search as viewed user
  Web->>View: Canonical impersonated read
  View->>Authz: documentFilter(impersonated actor)
  Authz-->>View: Target read scope
  View->>Vector: queryAuthorized(query, target ACL filter)
  Vector-->>View: Target-visible results
  View->>Events: publish(document.viewed, both actor identities)
  Events-->>View: Durable audit outbox
  View-->>Web: Target-visible results
  Admin->>Web: Attempt mutation as viewed user
  Web->>View: Canonical impersonated mutation
  View->>Authz: authorize(document.update, impersonated actor)
  Authz-->>View: Denied: impersonated sessions are read-only
```

Failure check: audit indexes effective target and real administrator. Channel, job, and event envelopes cannot strip provenance; all mutations deny.

## 15. Budget exhaustion during stream

```mermaid
sequenceDiagram
  actor User
  participant Web as Channel seam (Web)
  participant Pipeline as Chat pipeline seam
  participant Guard as Chat middleware (Output guardrail)
  participant Meter as Chat middleware (Usage metering)
  participant Budget as License gate seam (Budget counters)
  participant Events as Event bus seam
  User->>Web: Long/deep-research prompt
  Web->>Pipeline: run(request)
  Pipeline->>Budget: checkBudget(strictest scopes, estimate)
  Budget-->>Pipeline: Allowed + reservationId
  loop Every model chunk
    Pipeline->>Guard: handleChunk(chunk, abort)
    Guard-->>Pipeline: continue
    Pipeline->>Meter: handleChunk(usage delta, abort)
    Meter->>Budget: consumeBudget(delta, idempotencyKey)
    alt Budget remains
      Budget-->>Meter: allowed=true
      Meter-->>Pipeline: continue
      Pipeline-->>Web: Guarded chunk
    else Ceiling reached
      Budget-->>Meter: allowed=false + exhausted scope
      Meter-->>Pipeline: stop
      Pipeline->>Pipeline: abort(reason) provider controller
      Pipeline->>Budget: consumeBudget(final known usage)
      Pipeline->>Events: publish(chat.aborted.budget)
      Pipeline-->>Web: Terminal budget response; no more chunks
    end
  end
```

Failure check: atomic counters prevent concurrent overspend. Counter-store failure or stop verdict aborts provider and channel delivery; known usage remains charged.

## Review result

All fifteen use cases cross named seams for provider I/O, policy decisions, chat execution, retrieval, durable asynchronous work, events, notifications, licensing/budgets, and blob access. QA-driven review added explicit directory sync, ACL-only change propagation, anonymous embed identity, immutable impersonation provenance, reverse access diagnostics, and chunk-level budget/guardrail abort behavior.
