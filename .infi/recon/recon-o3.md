# O3 recon — backup / restore

Recon only. No code. Measured against `approof/main` at the time of writing; every
claim below has a file and line, or is marked as a question rather than a finding.

## 1. What has to be in a backup

Four stores, and they are **not** independent — restoring three of four leaves a
deployment that boots and is wrong.

| store | where | why it cannot be skipped |
|---|---|---|
| **PostgreSQL** | `DATABASE_URL` | users, workspaces, grants, `policy_versions`, `credential_store` rows |
| **`STORAGE_DIR`** | `documents/`, `direct-uploads/`, `vector-cache/` (`utils/files/index.js:7-18`) | source documents and the embedding cache |
| **vector store** | provider-dependent — LanceDB is **inside `STORAGE_DIR`** (`vectorDbProviders/lance/index.js:37-40`), the other nine are remote services | the embeddings themselves |
| **`SIG_KEY`** | environment, never on disk | without it `credential_store` is undecryptable ciphertext |

**LanceDB is the awkward one**: it is a *file* store under `STORAGE_DIR`, so a
naive "back up the directory" already captures it — and a naive "restore the
directory from a different point in time than the database" silently produces a
vector store that disagrees with `workspace_documents`. The other providers are
remote, so a `STORAGE_DIR` backup captures *nothing* of them and the same
inconsistency arrives from the opposite direction.

Any design that treats "the vector store" as one thing will be wrong for one of
these two groups.

## 2. `SIG_KEY` is the whole restore story

`credential_store` rows are AES-256-GCM under a key derived from `SIG_KEY`
(`models/credentialStore.js:96`), and `EncryptionManager` reads the same env var
(`utils/EncryptionManager/index.js:7`).

Consequences worth stating before anyone designs the bundle:

- A backup that contains `SIG_KEY` **is** the credentials, in the sense that
  matters — bundling both is equivalent to bundling every provider key in
  plaintext, however encrypted the rows look.
- A backup that omits it restores to a deployment where every `secret: true`
  value is unreadable. Since #48 the row is the only copy, so those credentials
  are **gone**, not merely unset.
- There is no middle position that is not a key-management decision.

The precedent is O5b (#94) and the audit redaction path: secrets do not travel in
an artifact handed to a human. Applying it here means `SIG_KEY` is supplied at
**restore** time by an operator, out of band, and the runbook has to say so
loudly — a restore that "succeeded" and left the instance unconfigured is the
failure mode people will hit.

**AAD binds more than the key.** `set()` calls
`cipher.setAAD(credentialAAD(envKey, KEY_VERSION))`
(`models/credentialStore.js:119`), so a row is bound to *its env key and key
version*. Restoring rows under different envKeys, or a future `KEY_VERSION`
bump, fails the auth tag rather than decrypting to garbage — which is the right
behaviour and needs a test asserting it, because "restore silently produced a
row that does not decrypt" and "restore refused" look identical in a runbook that
only checks exit codes.

## 3. Restore must run migrations, and that is not sufficient

30 migration directories today (`prisma/migrations`), latest
`20260902120000_groups_external_id_unique`. A dump from an older instance
restored into a newer binary needs `prisma migrate deploy` before the app can
read it.

But the authorization state has a second version axis: `policy_versions`, written
on every grant change (`utils/authorization/policyRepository.js:45-46`), with
grant rows carrying `policy_version` (`:355`). A restore that rolls the database
back also rolls **grants** back, which means:

- a grant revoked after the backup is **restored as live**
- the cache subscriber keys on version, so a restored-older version may be read
  as already-seen

That second point is a question I could not answer from reading alone and should
not guess at: **does the authorization cache invalidate correctly when
`policy_versions` moves backwards?** It is the difference between a restore that
is merely stale and one that serves a revoked grant.

## 4. Consistency between the four stores

There is no cross-store transaction anywhere, so a backup taken while the
instance is running captures four different instants.

The concrete failure, using the identifiers that actually exist:
`workspace_documents.docId` is `@unique` and the schema comment says it "stays
frozen" as the canonical reference; vectors carry `orgId` / `workspaceId` /
`docId` metadata for the T-5 ACL filter (`vectorDbProviders/lance/index.js:290`).
So:

- **pg newer than vectors** → a document row whose embeddings are absent: search
  returns nothing for a document the UI lists.
- **vectors newer than pg** → embeddings whose `docId` has no row. The ACL filter
  is metadata-based, so these are vectors whose *authorization context no longer
  exists*. That is the direction that matters — the T-5 report exists precisely
  because unprovable vectors must be refused rather than served.

A design that says "quiesce writes during backup" is answering this; a design
that does not must say what it does with orphans on both sides. Restoring pg and
vectors from **different** backups should probably be refused outright rather
than merged.

## 5. What a bundle must not contain

Reuse the O5b/redaction precedent rather than inventing one:

- no `SIG_KEY`, no decrypted `credential_store` values
- the diagnostic-bundle scrubber is **currently defeated by one invisible
  character** (#131, measured) — so if any part of a backup bundle is
  human-readable and passes through `scrubValue`, it inherits that hole until
  #131 lands
- `redactions: []` meaning "nothing found" is not evidence of cleanliness, for
  the same reason

## 6. RF list (what any O3 implementation must prove RED first)

- **RF-1 round trip**: backup → wipe → restore → the *same* authorization
  decisions. Asserted through the engine, not by comparing row counts: equal
  rows with a different `policy_version` is not a successful restore.
- **RF-2 no `SIG_KEY` in the artifact**: grep the produced bundle for the live
  key and for any decrypted credential value. Must fail before the fix.
- **RF-3 restore without `SIG_KEY`** fails **loudly** — refuses, rather than
  booting with silently-unconfigured providers.
- **RF-4 AAD**: a row restored under a different envKey, or with a bumped
  `KEY_VERSION`, is refused by the auth tag rather than yielding a wrong value.
- **RF-5 migration gap**: a dump older than HEAD restores only after
  `migrate deploy`, and the failure before it is legible.
- **RF-6 cross-store skew**: pg and vectors from different instants → orphans
  detected and reported, in **both** directions, with the vector-orphan case
  refusing rather than serving.
- **RF-7 revoked-grant regression**: revoke a grant, take a backup *before* the
  revocation, restore, and assert the grant is **not** live — or, if it is,
  that the runbook says so in words. This is the one I would write first.
- **RF-8 LanceDB vs remote**: the same restore path exercised for a file-backed
  provider and a remote one; they cannot share an assertion that only holds for
  one.

## 7. Open questions — not guesses

1. Does the authorization cache invalidate when `policy_versions` moves
   **backwards**? (§3)
2. Is a restore expected to be point-in-time consistent, or is "quiesce first"
   an acceptable operational requirement? The answer decides most of §4.
3. For remote vector providers, is the backup expected to capture them at all,
   or is the contract "re-embed after restore"? Re-embedding is expensive but
   removes the whole skew class.
4. Does `SIG_KEY` rotation need to be *possible* during restore (restore into a
   deployment with a different key), or is same-key-only acceptable for v1?
   `KEY_VERSION` exists (`credentialStore.js:17`) and looks intended for exactly
   this, but nothing uses it yet.
