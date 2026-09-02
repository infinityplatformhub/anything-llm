# Techlead-1 — #136 slice 2 pre-read: `offboardUser` (auth tier)

**Skills invoked:** `superpowers:requesting-code-review` (design read against measured source);
`security-review` checklist — privilege escalation via residual authority, authz bypass via a
stale cache, audit integrity. `infi-lessons` not invoked; no §7.17 line here.

§7.14: no suite run. Probes are in-process `node -e` on the real `inTransaction` shape.
Read: `policyRepository.js:45-67` (`bumpVersion`), `:389-448` (`revokeGrant`), `:497-509`
(`revokeDocumentAcl`), `:564-590` (`workspaceScopeKeysFor`), `:657-676` (`removeGroupMember`),
`:679-694` (exports); `cache.js:66-110`; TL-2's `05a32c365`; my `5f051a2a8`.

---

## (1) Direct `prisma` writes: **reject, and the reason is narrower than "layering"**

Confirmed as my N-3 condition. `removeGroupMember:660` calls `refuseGroupEscalation` and
`:661` derives scope keys from the **group row's `orgId`**, not a hardcoded 1 — a raw
`tx.group_members.deleteMany` skips both, so the removal succeeds and publishes either no
invalidation or one under the wrong `org:` key. `revokeGrant:409-444` reads the doomed rows
*before* deleting so it can write `grant_revocations` with the role name as it stood; a raw delete
destroys the only record that the grant ever existed, which is the half of my #135 (3) ruling that
a `deleteMany` silently drops. **Any direct write to `group_members`, `principal_role_grants` or
`document_acl` inside `offboardUser` is a reject** — not for tidiness, but because each primitive
carries a guard, a scope derivation, or an audit write that the raw statement does not.

## (2) One bump or N: **N, and do not try to make it one**

Measured the shape TL-2's ruling forces:

```
one outer tx, 3 inner calls -> transactions: 1  bumps: 3
```

`inTransaction(db, fn)` inlines when handed a `tx`, so the calls share the transaction and each
still runs its own `bumpVersion`. **There is no way to collapse them without exporting
`bumpVersion`, which TL-2 ruled against — so the question answers itself: `offboardUser` opens one
transaction, passes `tx` to every primitive, and accepts N rows.**

That is not a compromise; N is *correct*. The intermediate versions are written inside an
uncommitted transaction, so no reader ever observes one: `cache.js:97` compares
`entry.policyVersion === head`, and until commit `head` is unchanged for everyone else. After
commit the head jumps straight to the last version and every stale entry misses. **What atomicity
buys is rollback scope, not a tidy row count** — the same distinction I got wrong on #134 and was
corrected on. If the fourth removal fails, one transaction means none of the first three happened;
that is the property worth having, and it is orthogonal to how many `policy_versions` rows exist.

Write that reasoning into the code, because "why is this not one bump?" is the first question the
next reader asks. And do **not** let a fixture assert a bump count as the offboard's contract —
that pins an implementation detail that would change if the primitives ever batch.

## (3) Idempotency: **no rows AND no bump — achievable without exporting anything**

The trap: `removeGroupMember:669-671` says in its own comment that the version bumps even when the
delete matches nothing ("a caller that asked for the removal is entitled to know the cache reflects
reality"). Correct for a direct caller, wrong for a second offboard — call the primitives blindly
and the no-op offboard writes one `policy_versions` row per membership the user *used to* have.

**So `offboardUser` enumerates first and calls a primitive only for a row that exists.** Read the
user's `group_members`, `principal_role_grants` and `document_acl` rows inside the transaction, then
drive the primitives from that list. A second offboard finds nothing, calls nothing, bumps nothing —
zero rows and zero versions, with no change to the primitives and no `bumpVersion` export. It also
makes the audit event's counts real rather than derived from `deleted` totals, which is QA-1's
`membershipsAdded` note in the other direction.

```
RF-I : offboard the same user twice; the SECOND call writes zero group_members
       deletions, zero grant_revocations, and zero policy_versions rows —
       asserted as an exact count on a pinned baseline, not ">= 0"
mut  : call the primitives unconditionally
why  : every "the user has no access afterwards" assertion is green under that
       mutation — the user is already offboarded. Only a policy_versions count
       separates a no-op from a re-run, and it must be exact: the row count
       after the first offboard is the baseline, so ">= baseline" passes.
```

Pair it with TL-2's required fixture (`cache.invalidateScopes` fired for a workspace the user was a
member of, driven through the real cache rather than asserting `bumpVersion` was called) — that one
is what catches the wrong-`org:`-key failure, and it is the reason raw writes are barred in (1).

**One thing to settle before GREEN, not after:** `document_acl` rows are keyed by
`principal_id` TEXT with no FK (`schema.prisma:911`), so enumerating them for a user is a
string match — the same recycling surface #135 exists to close. `offboardUser` must remove them
through `revokeDocumentAcl`, and RF-1 from `5f051a2a8` must cover an ACL row as well as a role
grant, or the ACL half ships untested.
