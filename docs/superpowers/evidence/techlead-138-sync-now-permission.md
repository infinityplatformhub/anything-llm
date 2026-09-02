# Techlead-1 — #138: the sync-now permission, and the shared-claim-lease question

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
privilege escalation via a new action, blast radius of a grant, authorization correctness of the
claim lease. `infi-lessons` not invoked.

§7.14: no suite run. Probes are `node -e` and source reads in the main checkout (read-only) and
`/tmp/tl-138q` at `2cdb884ef`.

---

## (A) Sync now: **option (a) — a new seeded `directory.sync` action, `super_admin` only. `setup_admin` does not get it.**

**Reuse is refused, and the vocabulary says why.** I listed all 62 actions: there is **no
identity-, directory-, sso- or sync-named action in the seed at all** (grep returns nothing). So
reuse means widening something whose name is about a different subject — `system.write`
("configure the instance"), `user.manage` ("administer accounts"), or `scheduled-job.write`
(which gates `endpoints/scheduledJobs.js`, the *agent* scheduler, a completely different feature
that happens to share the word "job"). Each of those is the #113/#128 drift I have rejected twice,
and `scheduled-job.write` would be the worst of them: two unrelated features behind one action
means a grant for one silently confers the other, with nothing in either name to show it.

**Why a new action is cheap here and was not for `audit.purge`:** `audit.purge` had to be *split
off* an action people already held, so the migration had to reason about existing grants.
`directory.sync` names a capability that **exists nowhere today** — the endpoint is new. A new
row granted to `super_admin` only takes nothing from anyone.

**`setup_admin`: no, and this is the #137 lesson applied rather than repeated.** Twice in #137 a
capability granted for a stated reason conferred an unrelated authority under a different name —
`audit.purge` (erase the trail it may not read) and `model-router.write` (redirect chats it may
not read). `directory.sync` is the same shape a third time: triggering a sync runs
`applyDirectoryPlan`, which **suspends users** (`applyDirectoryPlan.js:142-147`) and adds/removes
group memberships — i.e. it mutates the authorization graph for the whole org from one button.
`setup_admin` is "finish the installation"; a directory sync is steady-state identity operations.
The role also already holds `user.manage`, so granting this would let it deactivate accounts *in
bulk, indirectly*, past the guards `offboardUser` is being built to enforce in #136. Refuse.

**Ledger requirements, all measured against #137's actual failure path:**

1. **Seed and migration together.** `AUDIT_ACTIONS`-style: add to the seed vocabulary constant so `ALL_ACTIONS` carries it (`super_admin.permissions === ALL_ACTIONS` is an identity — verified — so super_admin gains it structurally), **and** insert the permission row plus the explicit `super_admin` grant in the migration. The `20260902020000` CROSS JOIN covers permissions existing *then*; a later row reaches nobody without its own grant, or the endpoint is gated on an action no principal holds — dead for everyone.
2. **`vocabulary-diff.test.js` pin 63 → 64**, with the action's reason in the approved list. That file is the only count pin — I swept every `ALL_ACTIONS` reader for #137 and the rest assert membership or inequalities.
3. **`t1-authz-migration.test.js:186`** (migrated vocabulary == seed, both directions) is the test that catches a seed/migration split. It needs nothing new; it needs the seed edit not to be forgotten.
4. **A deny assertion for `setup_admin`** beside the allow for `super_admin`, in the same file. "Denied" alone is satisfied by an action granted to nobody — the #63 shape.
5. **Timestamp after the highest merged migration**, and not colliding with an existing prefix (the `120000` lesson).

## (B) The shared claim lease: **option (1) — accept, with the comment. Do not go per-type.**

QA-1's reading of `JobRuntime.js:51-52` is correct: one `claim` covers every registered type at
`Math.max(...types.map(leaseMsFor))`, so once `directory.sync` registers, a `telemetry.flush` job
is written with a 160s `leaseUntil` and only shrinks to 30s at its first heartbeat
(`PostgresJobQueue.js:204-208` sets `leaseUntil` from the `leaseMs` the *run* site passes). A
worker dying in that window leaves a 30s job unclaimable for 160s.

**Accept it, for a reason that is not "it is small":** the claim lease's only job is to be **long
enough**, and the cost of being too long is bounded and benign — a delay before takeover of a
*dead* worker. The cost of being too short is a second worker starting a concurrent apply while
the first is alive, which is the failure this entire slice exists to prevent. Those are not
symmetric, and `Math.max` errs in the safe direction by construction. Per-type claiming means
either N round trips per tick or a claim that must reason about mixed leases inside one
transaction — real complexity bought against a 130-second delay on a telemetry flush.

Two conditions:

- **The comment at `:45-49` must say this explicitly** — that non-sync types inherit the maximum for the claim window, that it shrinks at the first heartbeat, and that the asymmetry above is *why*. The existing comment explains the max/min tension in general; it does not say that a short-lease job wears the long lease.
- **The test QA-1 asks for**, and it must be the shape that can fail:

```
RF-3d : with directory.sync registered, a telemetry.flush job's leaseUntil after claim is
        the DIRECTORY_SYNC value, not DEFAULT_LEASE_MS — asserted on the row
mut   : claim with DEFAULT_LEASE_MS
why   : this pins the accepted behaviour rather than leaving it as a comment nobody
        re-derives. If a future change makes it per-type, this test is where the
        decision is revisited deliberately instead of drifting.
```

**This interacts with my FINDING 1 in `bbe87dc2e` and makes it worse, not better.** `leaseMsFor`
keys on the bare `"directory.sync"` while production types are provider-qualified
(`directory.sync:lark`), so today `Math.max` over the registered types returns **30s** — the sync
gets the fallback *and* nothing inherits anything. Fix the prefix resolution first; QA-1's
inheritance concern only becomes real once it does.
