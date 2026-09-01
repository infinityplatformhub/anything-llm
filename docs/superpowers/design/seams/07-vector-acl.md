# Vector ACL seam

## Responsibility

Store, query, and delete vectors while enforcing authorization-produced document ACL filters inside every retrieval operation. Normalize provider scores and return source metadata without exposing forbidden candidates.

## Driver contract

This extends existing `VectorDatabase` subclasses and preserves CommonJS driver shape.

```js
/** `workspaceIds` holds real workspace ids only; whole-org scope is the separate `orgWide` flag, never a sentinel entry. When `orgWide` is true the driver skips workspace narrowing but still applies every other predicate.
 * @typedef {{orgId:string, principalType:"user"|"service"|"embed", actorId:string, workspaceIds:string[], orgWide:boolean, deniedDocumentIds:string[], attributes:Object, allowedDocumentIds?:string[], matchNone:boolean, policyVersion:string}} DocumentAclFilter */
/** @typedef {{text:string, score:number, metadata:{documentId:string, chunkId:string, workspaceId:string, hidden:boolean, [key:string]:any}}} VectorHit */
class VectorDatabase {
  /** @returns {string} */
  get name() {}
  /** @param {Object} config @returns {Promise<{error:string|null, success:boolean}>} */
  static async validateConnection(config) {}
  /** @param {{namespace:string, chunks:Object[], documentId:string, workspaceId:string, hidden?:boolean}} input @returns {Promise<{vectorIds:string[]}>} */
  async upsertDocument(input) {}
  /** ACL filter is REQUIRED, never nullable. @param {{namespaces:string[], queryVector:number[], topN:number, similarityThreshold:number, aclFilter:DocumentAclFilter, metadataFilters?:Object, signal?:AbortSignal}} input @returns {Promise<VectorHit[]>} */
  async queryAuthorized(input) {}
  /** @param {{documentId:string, namespaces?:string[]}} input @returns {Promise<{deleted:number}>} */
  async deleteDocument(input) {}
  /** Hide takes effect for new queries before returning. @param {{documentId:string, hidden:boolean}} input @returns {Promise<void>} */
  async setDocumentVisibility(input) {}
}
module.exports = { VectorDatabase };
```

`queryAuthorized` must apply tenant/workspace scope, metadata-only `hidden=false`, denied-document exclusions, attribute predicates, optional bounded allow-list, and metadata filters in provider query. Normal production filters are denied-only plus indexed attributes (workspace, group/principal grants, document set); `allowedDocumentIds` is reserved for small explicit scopes such as embed keys and MUST NOT be generated as an organization-wide IN-list.

For multiple namespaces, driver queries each namespace with the same ACL and enough candidates, normalizes scores, performs a stable global merge by score descending then `namespace + chunkId`, removes duplicates, and returns at most global `topN`—not `topN` per namespace. Provider pushdown or equivalent secure per-namespace over-fetch may be used, but forbidden candidates never cross seam.

## First driver

`LanceDb` extended with `queryAuthorized`; it is current default. All configured providers must implement capability before document ACL launch; unsupported provider is rejected at setup, never silently unfiltered.

## Boundaries

- Driver MUST NOT calculate actor permissions, query roles/groups, or accept raw actor as substitute for `DocumentAclFilter`.
- Driver MUST NOT treat missing/invalid ACL filter as unrestricted; callers cannot opt out, including admin and jobs.
- Driver MUST NOT return forbidden metadata/text for core post-filtering.
- Driver stores vector/chunk data, not canonical document ownership or ACL policy.
- Emergency hide MUST NOT wait for re-embedding or physical deletion. `setDocumentVisibility` updates visibility metadata/index only; it MUST NOT alter embeddings, chunks, canonical ACLs, or content.

## Failure semantics

Missing/malformed/stale-scope ACL filter throws `VectorAclRequiredError` before query. Provider without secure filter support throws `VectorAclUnsupportedError` at validation. Timeout/provider error throws retryable `VectorUnavailableError`; never falls back to a different unfiltered provider. Empty authorized scope returns `[]`. Partial provider results are allowed only if every returned hit passes filter and response declares no hidden candidate. Delete and repeated visibility updates are idempotent. Score normalization must clamp to `[0,1]`; invalid scores are dropped.
