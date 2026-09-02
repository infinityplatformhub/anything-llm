# Techlead-1 — #134 mid-flight structural rulings

Two rulings Dev3 flagged before pushing. Both accepted; the second carries a condition.
Measured against `prisma/schema.prisma` and `utils/identity/directoryDiff.js` on
`approof/main`.

## Ruling 1 — checkpoint PK `BIGINT IDENTITY`, `orgId INTEGER NOT NULL DEFAULT 1`, no FK: **ACCEPT**

Measured. Every neighbouring table in the authorization schema declares `orgId Int
@default(1)`: `:779` (roles), `:802` (principal_role_grants), `:824` (groups), `:854`
(documents), `:877` (document_acl), `:929` (grant_revocations). `grep organizations
schema.prisma` returns nothing, so there is no table to reference and an FK would have no
target. Widening only this column would force a cast on every join against those six.

The `BIGINT` primary key is not novel either — `policy_versions.version` is already
`BigInt @id @default(autoincrement())` (`:905`), in the same subsystem.

Nothing to weigh here; the convention is uniform and the alternative is strictly worse.

## Ruling 2 — `enumerateDirectory` lives in `directoryDiff.js`: **ACCEPT with a condition**

The reasoning is right and I could not improve on it: `COMPLETE` is module-private, and
exporting the symbol so a sibling file can brand values recreates the exported constructor
with extra steps. The whole point of slice 1's residual fix is that exactly one function can
produce a branded value; that function has to live where the symbol does.

**The condition is about what the file now claims about itself.** `directoryDiff.js`'s header
says the module "computes; it does not write, and it cannot: it imports no database client and
no repository (R6, pinned by a source test)". `enumerateDirectory` calls a driver, which is
I/O — so the sentence becomes partly untrue, and T7 does not catch it because a driver is
neither a db client nor a repository.

Two things asked for:

- **(a) Correct the header.** R6 can stay as "no database client and no repository" — that is
  still the property that matters, since it is what stops a diff from writing. But the file
  must say that `enumerateDirectory` calls a driver and why it lives here (the brand is
  module-private), or the next reader takes "cannot do I/O" from a paragraph that no longer
  means it.
- **(b) Extend T7** to pin both halves: no db client, no repository, **and** no concrete driver
  import — the driver arrives as an argument only. Without that second assertion, "this file
  does not reach the network" is a sentence with nothing enforcing it, and the next person to
  need a Lark call has an obvious place to put it.

I considered and rejected the alternative (a separate `directoryEnumeration.js` sharing the
symbol): sharing it means exporting it, which is the thing being avoided. Dev3's placement
wins on the argument they gave.

`completedEnumeration` moving behind `__testHelpers__` is as agreed in the slice 2 pre-read.

## Note carried to #136

`offboardUser` in `policyRepository` (TL-2 ruling `05a32c365`) will be reviewed on two points
already established here: it must route membership removal through `removeGroupMember` rather
than `prisma.group_members` (#113's version bump and outbox publish live in that function), and
its witness test must resolve the actor through the runtime path rather than passing a
constant — the same reason as slice 2's N-3, since `CoreJobWorker.claim:14-19` re-resolves and
refuses a deactivated actor.
