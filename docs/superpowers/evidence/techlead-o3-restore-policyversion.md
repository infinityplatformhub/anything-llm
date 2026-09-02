# Techlead-1 — O3 question: does a restore that rewinds `policy_versions` break FilterCache?

Asked by PMO off Dev2's `recon-o3.md`. Answered by probe, not by reading — the real
`FilterCache` from `utils/authorization/cache.js` driven against a stub whose
`policy_versions` head I control, so a restore is modelled exactly as "the head goes
backwards".

Read: `utils/authorization/cache.js:82-118` (`get`, `isStale`), `:37-42` (`scopesFor`),
`policyRepository.js:512-518` (`currentPolicyVersion`), `schema.prisma:904-912`.

## Short answer

**Yes, there is a real hole, and it is not the one the question names.** A head that is merely
*lower* than the cached stamp is safe — the comparison is `!==`, not `<`. The hole is the
**version numbers being reused** after the rewind: `policy_versions.version` is
`BigInt @default(autoincrement())`, and a restore rewinds the sequence along with the rows, so
the same version number is issued twice for two different policy states. A cache entry stamped
with the pre-restore `105` becomes fresh again the moment normal operation re-reaches `105`.

**A single bump after restore does not fix it.** That is the answer to PMO's second question:
it closes the window only until the sequence catches up.

## Measured

`FilterCache.get:94-99` compares `entry.policyVersion === head` — an equality, so a lower head
is a mismatch and the entry is rebuilt:

```
populate at head 100        -> v100   builds 1
head advances to 105        -> v105   builds 2      (correct: newer policy)
head rewinds to 100         -> v100   builds 3      (rebuilt — a LOWER head is not "fresh")
```

So the direct reading of the question — "head goes down, stale entry served" — is **not** the
failure. Equality saves it.

The failure is version reuse:

```
entry stamped 105 (pre-restore)
restore rewinds head to 100
normal operation bumps 101..105 again
head is 105 again           -> build2  builds 2     (STALE ENTRY SERVED)
isStale({policyVersion:"105"}) -> false
```

The cached filter describes the pre-restore policy; the database describes the post-restore one;
both call themselves version 105. `isStale` agrees they match, because the only thing it can
compare is the number.

The window is bounded by how long the sequence takes to climb back, which on a busy install is
minutes, not days — but it is exactly the window in which an operator is checking that a
restore worked, and in-process caches from before the restore are the ones most likely still
warm.

## What actually protects this today, and why it is not enough

Three things narrow it and none closes it:

- **The 30s TTL** (`DEFAULT_TTL_MS`) bounds any single entry. Its own comment says it is "a memory bound only; correctness comes from the version stamp" — so relying on it here means relying on the thing the file says is not the correctness mechanism. It also does not help the process that keeps rebuilding an entry every few seconds from a database that has not yet re-passed the reused version.
- **`policy.changed` invalidation** drops entries by scope key (`invalidateScopes:66-76`). Any post-restore write publishes one, and every entry carries `org:<id>` (`scopesFor:38-41`), so in practice the first write after a restore clears the org's entries. That is real protection — but it is protection by side effect: it holds only if a write happens, only if the bus is up, and nothing about a restore guarantees either. A restored-and-idle instance keeps its pre-restore cache.
- **A restart clears everything**, since the cache is in-process. Most restores involve one. "Most" is the problem.

## Recommendation

**Do not bump once. Jump the sequence past the highest version that has ever existed.** After a
restore, read the max version from the backup being restored (or from the pre-restore instance
if reachable) and `setval` the `policy_versions` sequence above it, then write one row. Every
subsequent version is then a number no cache entry can be holding, and the reuse window closes
by construction rather than by a race.

If the pre-restore maximum is unknowable — the honest common case, since the instance you are
restoring is usually the one that broke — the fallback that still works is **jump by a wide
margin** (the restored max plus a constant far larger than any plausible drift) and record the
jump. Wasting version numbers costs nothing; `BigInt` does not run out.

Two supporting measures, both cheap:

1. **`FilterCache.invalidateAll()` as part of the restore runbook**, on every process. It exists (`:78-80`) and is the correct blunt instrument. It does not survive a process that starts *after* the restore-runbook step but reads a database still climbing back through reused numbers — which is why it is supporting, not sufficient.
2. **Record the restore in `policy_versions` itself** with a distinct `change_type` (e.g. `restore`). Cheap, and it makes the discontinuity visible to anyone later asking why the numbers jump.

## What I would tell Dev2 to put in the recon

The question as posed ("does a lower head invalidate correctly") has a clean answer — yes, the
comparison is equality — and stopping there would leave the real defect unrecorded. The recon
should state the mechanism as **version reuse after a sequence rewind**, name the equality as
what makes the naive direction safe, and name the sequence jump as the fix. A one-line "restore
must bump the version" would read as done and would not be.

I have not checked whether any other subsystem stamps `policy_versions` values into durable
storage; if one does, it has the same reuse problem with a much longer window than an in-memory
cache. Worth one grep before the recon is closed.

## Addendum — the grep I asked for, run

Three tables carry a durable `policy_version BigInt` column: `principal_role_grants`
(`schema.prisma:810`), `document_acl` (`:885`), and the revocation log (`:938`). All three are
written by `policyRepository` (`:355`, `:368`, `:441`, `:489`, `:491`) and — measured — **none is
ever read back for a comparison**. The only non-test reader is
`engine.test.js:266` asserting the number went up.

So they are provenance stamps, not freshness checks, and version reuse does not create a second
hole there. Worth stating in the recon so the next reader does not have to repeat the grep: the
reuse problem is confined to `FilterCache`'s in-memory stamp, and the fix is the sequence jump.
