# Techlead-1 — #134 S4b slice 2 `fe6d92e69` (auth): **PASS**, and my F1 premise was wrong

§7.14: no suite run. Probes are in-process `node -e` driving the real `addGroupMember` against
a stub db in a detached worktree (`git worktree add --detach /tmp/tl-134 fe6d92e69`, Node 22).

## My F1 premise was false, and Dev3 is right about the witness

I claimed passing a `tx` instead of `prisma` would **collapse the version bumps**, and asked for
RF-2 to count `policy_versions` rows as the witness. Measured, driving the real function twice:

```
pass prisma : policy_versions rows 2 | transactions opened 2
pass tx     : policy_versions rows 2 | transactions opened 0
```

`bumpVersion` runs once per `addGroupMember` call regardless of what `db` is, so the row counts
are identical and **the witness I specified cannot exist**. I reasoned from "one transaction" to
"one bump" without checking where the bump is called from. Accepted; Dev3's M2/M3 are genuine
unkillable survivors under §7.9, and recording them as such is the correct disposition.

**The ruling stands on the grounds Dev3 gives, and they are the real ones.** The observable
difference is rollback scope, which I measured:

```
pass prisma, second write fails -> committed: bump, member1
```

The first membership survives the second one's failure. Under a shared `tx` it would not: one
conflicting row discards every correct write in the run — the "all-or-nothing failure" the
parent recon's §2 rejects, and the thing per-entity batching exists to prevent. Lock duration is
the second ground and equally real.

**On a conflict-fixture witness:** it would be honest, but I would not ask for it here. It needs
a write that fails *after* an earlier one succeeded, and a fixture that arranges that reliably is
mostly testing Prisma's transaction semantics rather than this file's decision. The comment at
`applyDirectoryPlan.js:129-145` already does the load-bearing work — it states the mechanism,
quotes `inTransaction`, and says explicitly that the next reader will think a transaction is
missing and why it is not. That is the right defence for a property no test can hold.

RF-2 as written (`applyDirectoryPlan.test.js:176-227`) is still worth having: it counts 2 bumps
and 2 outbox rows against a real database, and pairs them with an assertion that the memberships
exist — so a bump with no write, or a write with no bump, both fail. It is a good test with a
mistaken rationale in its comment ("the F1 witness"). Worth one line correcting that, since a
comment claiming a mutant is killed when it is not is the §7.17 shape.

## Both conditions from my ruling landed, and (ข) landed stronger than asked

**(a) docblock** — corrected at the head of `directoryDiff.js`.

**(b) T7** (`directoryDiff.test.js:619-652`) strips comments first (so a prohibition written in a
comment cannot satisfy its own grep), then asserts no prisma, no `policyRepository`, no
`group_members`, no `identityProviders` require, no `IdentityProvider` identifier, no http
client — and finally:

```js
const requires = [...code.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]);
expect(requires).toEqual([]);
```

The exact-empty require list is better than the enumerated prohibitions I asked for: it makes
*any* future import a deliberate edit to this test rather than a line nobody notices. That is the
difference between a denylist and a closed door.

## N-2 implemented, and tested in all three shapes

`enumerateDirectory` asserts the promised shape before branding, and the test (`:429-465`) covers
a full partial (`hasMore` + `nextCursor`), a half-partial (`hasMore` alone — the realistic
version, a driver that forgets to clear one field), and the **groups** call as well as the
principals call. The control at `:468` ("a complete pair IS branded, and drives deactivation") is
what stops every refusal above being satisfied by a function that always throws.

## The rest of the RF list

- **RF-1** (`:114`) asserts zero rows across every table on a refused plan, and RF-2b (`:232`) is its control — an accepted plan does apply its destructive half. Without that pair, a reconciler that never writes passes.
- **RF-3** (`:380`) asserts the diff never sees the first call's data, not merely that the second call throws — so a mutant that brands before throwing dies.
- **RF-4** (`:500`) asserts the outstanding work *completes* on the second run, which is what a run-id skip mutant fails; RF-4b (`:604`) pins idempotency in the applier rather than the diff.
- **RF-5** (`:679`) both runs write zero rows and the checkpoint distinguishes them; `:745` adds a database-level CHECK that a refusal cannot be recorded without a reason.
- **RF-6** (`:775`, `:802`) drives `addGroupMember` with an actor from `identityStore.resolveActor` and, in the other direction, proves a deactivated actor cannot drive the apply — the N-3 shape, both halves.
- **`:492`** asserts the brand constructor is off the production surface, closing slice 1's residual.

## Verdict

**PASS.** One correction to make: RF-2's comment calls itself the F1 witness, which the
measurement above disproves. The test earns its place on other grounds; the comment should say
so.

## Slice 3 lock — ruling

Dev3 asks me to choose between infi-stack rung-0 (`pg_advisory_xact_lock` only) and my
lock-row-plus-heartbeat. Both reject `pg_advisory_lock`, so the disagreement is narrow.

**I withdraw the lock-row recommendation. Take rung-0: `pg_advisory_xact_lock`.** Not because the
rung says so, but because my reasoning had a gap: I argued a transaction-scoped lock "cannot span"
a per-entity apply, and treated that as disqualifying. It is not — it is a design constraint that
points at a better shape.

A lock row with a heartbeat is a lock **reimplemented in application code**: it needs an expiry
rule, a staleness policy, a decision about what happens when a heartbeat is late but the holder is
alive, and a way to break a lock left by a crashed process. Every one of those is a correctness
question with no help from the database, and getting one wrong produces two concurrent syncs —
the exact failure the lock exists to prevent, arriving through the mechanism meant to prevent it.

The shape that fits both constraints: take `pg_advisory_xact_lock` in a **short transaction that
claims the run** — write a `running` checkpoint row, commit, release. Concurrency is then decided
by that row, whose lifecycle is already `status` + timestamps the checkpoint table carries, and
the advisory lock only guards the claim, which is short by construction. A crashed holder leaves a
stale `running` row, which is a visible operator problem with a clear remedy rather than an
invisible lock nobody can see. That is strictly better than my heartbeat: same property, no
bespoke expiry logic, and the failure mode is legible.

If that shape does not survive contact with slice 3's design, the fallback is rung-0 as written
and a documented residual — not a hand-rolled lock.
