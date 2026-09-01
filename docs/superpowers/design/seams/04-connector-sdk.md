# Connector SDK seam

## Responsibility

Standardize external-source authentication, discovery, incremental sync, content fetch, source ACL mapping, health, and checkpoints. Core orchestration converts returned documents into storage/indexing operations through authorization and vector seams.

## Driver contract

```js
/** @typedef {{cursor:string|null, watermark:string|null, version:number}} SyncCheckpoint */
/** @typedef {{sourceId:string, title:string, mime:string, modifiedAt:Date, deleted:boolean, etag:string|null, parentId:string|null}} SourceDocument */
/** @typedef {{visibility:"private"|"org"|"restricted", userExternalIds:string[], groupExternalIds:string[], inheritedFrom:string|null}} SourceAcl */
/** @interface ConnectorDriver */
class ConnectorDriver {
  /** @returns {string} */
  static connectorId() {}
  /** @param {Object} config @returns {Promise<{ok:boolean, details:Object}>} */
  static async validateConnection(config) {}
  /** @param {{checkpoint:SyncCheckpoint, scope:Object, limit:number, signal:AbortSignal}} input @returns {Promise<{documents:SourceDocument[], next:SyncCheckpoint, hasMore:boolean}>} */
  async listChanges(input) {}
  /** @param {{sourceId:string, etag?:string, signal:AbortSignal}} input @returns {Promise<{stream:NodeJS.ReadableStream, mime:string, etag:string, metadata:Object}>} */
  async fetchContent(input) {}
  /** @param {{sourceId:string}} input @returns {Promise<SourceAcl>} */
  async fetchAcl(input) {}
  /** @returns {Promise<{status:"healthy"|"degraded"|"failed", message:string|null}>} */
  async health() {}
}
module.exports = { ConnectorDriver };
```

Checkpoint advances only after core durably commits content, mapped ACL, and indexing/outbox state. External user/group IDs require core identity mapping before authorization use.

## First driver

`GoogleDriveConnector`; `LarkDocsConnector` follows same contract. Both are scheduled through job queue.

## Boundaries

- Driver MUST NOT write app DB, storage, vector DB, document ACL tables, audit log, or checkpoints directly.
- Driver MUST NOT decide local users/groups/workspaces or broaden unmapped/unknown ACL principals.
- Driver MUST NOT enqueue itself or own retry cadence; job queue owns orchestration.
- Driver returns source data only; parsing, chunking, embedding, retention, emergency hide, and search visibility belong to core seams.
- Credentials MUST use encrypted credential storage and logs must scrub them.

## Failure semantics

Auth revocation/invalid grant throws non-retryable `ConnectorAuthenticationError` and marks connection failed until reauthorized. Rate limit and transient remote/network failures throw retryable `ConnectorUnavailableError` with retry-after where supplied. Missing source during fetch is an idempotent tombstone. Malformed content/ACL is quarantined per document, emits failure event, and does not advance that item checkpoint. Unknown ACL mapping defaults to no access, never organization-wide. Replaying a page/checkpoint must be safe through stable `sourceId + etag` idempotency.
