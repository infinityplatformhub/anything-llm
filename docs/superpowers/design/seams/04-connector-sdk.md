# Connector SDK seam

## Responsibility

Standardize external-source authentication, discovery, incremental sync, content fetch, source ACL mapping, health, and checkpoints. Core orchestration converts returned documents into storage/indexing operations through authorization and vector seams.

## Driver contract

```js
/** @typedef {{cursor:string|null, watermark:string|null, version:number}} SyncCheckpoint */
/** @typedef {{sourceId:string, title:string, mime:string, modifiedAt:Date, deleted:boolean, etag:string|null, aclRevision:string|null, parentId:string|null}} SourceDocument */
/** @typedef {{sourceId:string, aclRevision:string, deleted:boolean}} SourceAclChange */
/** @typedef {{visibility:"private"|"org"|"restricted", userExternalIds:string[], groupExternalIds:string[], inheritedFrom:string|null}} SourceAcl */
/** @interface ConnectorDriver */
class ConnectorDriver {
  /** @returns {string} */
  static connectorId() {}
  /** @returns {{aclDelta:boolean}} */
  static capabilities() {}
  /** @param {Object} config @returns {Promise<{ok:boolean, details:Object}>} */
  static async validateConnection(config) {}
  /** @param {{checkpoint:SyncCheckpoint, scope:Object, limit:number, signal:AbortSignal}} input @returns {Promise<{documents:SourceDocument[], next:SyncCheckpoint, hasMore:boolean}>} */
  async listChanges(input) {}
  /** @param {{sourceId:string, etag?:string, signal:AbortSignal}} input @returns {Promise<{stream:NodeJS.ReadableStream, mime:string, etag:string, metadata:Object}>} */
  async fetchContent(input) {}
  /** Optional when capabilities().aclDelta is true. @param {{checkpoint:SyncCheckpoint, limit:number, signal:AbortSignal}} input @returns {Promise<{changes:SourceAclChange[], next:SyncCheckpoint, hasMore:boolean}>} */
  async listAclChanges(input) {}
  /** @param {{sourceId:string}} input @returns {Promise<SourceAcl>} */
  async fetchAcl(input) {}
  /** @returns {Promise<{status:"healthy"|"degraded"|"failed", message:string|null}>} */
  async health() {}
}
module.exports = { ConnectorDriver };
```

Content and ACL checkpoints advance only after core durably commits content, mapped ACL, visibility/indexing, and outbox state. `aclRevision` participates in change detection independently from content `modifiedAt`/`etag`. External user/group IDs require core identity mapping before authorization use. Drivers without ACL delta support MUST be scheduled for a full ACL resweep at least every 24 hours (deployment may tighten cadence); each resweep calls `fetchAcl` for every in-scope live document and keeps affected documents hidden when ACL cannot be confirmed.

## First driver

`GoogleDriveConnector`; `LarkDocsConnector` follows same contract. Both are scheduled through job queue.

## Boundaries

- Driver MUST NOT write app DB, storage, vector DB, document ACL tables, audit log, or checkpoints directly.
- Driver MUST NOT decide local users/groups/workspaces or broaden unmapped/unknown ACL principals.
- Driver MUST NOT enqueue itself or own retry cadence; job queue owns orchestration, including mandatory fallback ACL resweeps.
- Content-unchanged documents with changed `aclRevision` MUST flow through ACL mapping and vector visibility update without refetch/re-embedding.
- Driver returns source data only; parsing, chunking, embedding, retention, emergency hide, and search visibility belong to core seams.
- Credentials MUST use encrypted credential storage and logs must scrub them.

## Failure semantics

Auth revocation/invalid grant throws non-retryable `ConnectorAuthenticationError` and marks connection failed until reauthorized. Rate limit and transient remote/network failures throw retryable `ConnectorUnavailableError` with retry-after where supplied. Missing source during fetch is an idempotent tombstone. Malformed content/ACL is quarantined per document, emits failure event, and does not advance that item checkpoint. Unknown ACL mapping defaults to no access, never organization-wide. Replaying content or ACL page/checkpoint must be safe through stable `sourceId + etag + aclRevision` idempotency. ACL revocation mapping failure hides the document immediately and retries; stale prior grants are never retained as fallback.
