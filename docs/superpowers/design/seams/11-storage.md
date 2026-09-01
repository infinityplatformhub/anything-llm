# Storage seam

## Responsibility

Store and retrieve opaque document, export, backup, and generated-file blobs behind tenant-scoped keys. Support local disk now and S3-compatible storage later without exposing filesystem/provider paths to business code.

## Driver contract

```js
/** @typedef {{orgId:string, kind:"document"|"export"|"backup"|"generated", objectId:string, version:string}} StorageKey */
/** @typedef {{key:StorageKey, size:number, checksum:string, contentType:string, createdAt:Date}} StoredObject */
/** @interface StorageDriver */
class StorageDriver {
  /** @param {Object} config @returns {Promise<{ok:boolean, details:Object}>} */
  static async validateConnection(config) {}
  /** Atomic publish after checksum. @param {{key:StorageKey, stream:NodeJS.ReadableStream, contentType:string, expectedChecksum?:string, metadata?:Object}} input @returns {Promise<StoredObject>} */
  async put(input) {}
  /** @param {{key:StorageKey, range?:{start:number,end?:number}}} input @returns {Promise<{stream:NodeJS.ReadableStream, object:StoredObject}>} */
  async get(input) {}
  /** @param {{key:StorageKey}} input @returns {Promise<StoredObject|null>} */
  async stat(input) {}
  /** @param {{key:StorageKey}} input @returns {Promise<void>} */
  async delete(input) {}
  /** Server-side copy where supported. @param {{source:StorageKey, destination:StorageKey}} input @returns {Promise<StoredObject>} */
  async copy(input) {}
}
module.exports = { StorageDriver };
```

Core generates typed keys; driver maps them to safe paths/object names. Reads and writes stream with bounded memory. Encryption at rest relies on deployment disk/S3 policy; application-level credential encryption is separate.

## First driver

`LocalDiskStorageDriver`, rooted under configured storage directory with atomic temporary-file rename. `S3CompatibleStorageDriver` follows for MinIO.

## Boundaries

- Driver MUST NOT authorize callers, derive tenant from path text, parse/index content, manage document records, or return public URLs.
- Business code MUST NOT use direct `fs` paths for managed objects.
- Key mapping MUST prevent traversal, symlink escape, tenant collision, and user-controlled absolute paths.
- Driver MUST NOT log blob content or sensitive metadata.
- Retention jobs decide deletion; storage only executes requested idempotent operation.

## Failure semantics

Invalid key/path throws non-retryable `StorageKeyError`. `put` becomes visible only after full stream, checksum validation, and atomic commit; partial objects are cleaned up. Checksum mismatch throws `StorageIntegrityError`. Missing `get` throws `StorageNotFoundError`; `stat` returns null; repeated delete succeeds. Capacity/network/temporary provider failures throw retryable `StorageUnavailableError`. Copy never deletes source and cannot leave a visible partial destination. Tenant escape detection fails closed and emits security event outside driver.
