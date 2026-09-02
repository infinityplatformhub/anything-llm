# Techlead-1 — #138 queue half `4c01ac1ca` (auth): **PASS with one required addition**

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization correctness (two concurrent applies), new-action gating, test seam reachable from
production; `infi-lessons` for the §7.17 line below.

§7.14: no suite run. Probes are in-process `node -e` and source reads in a detached worktree
(`/tmp/tl-q` at `4c01ac1ca`, Node 22 via `/opt/homebrew/opt/node@22/bin`).

Ticked against my pre-written checklist `f76baeac2`. Each row below states what I made fail, or
says I could not.

---

## The checklist

**RF-3c / prefix resolution — PASS, measured.** The finding from `2cdb884ef` is closed:

```
DIRECTORY_SYNC_LEASE_MS: 160000
  directory.sync        -> 160000
  directory.sync:lark   -> 160000     ← was 30000 (FALLBACK)
  directory.sync:ldap   -> 160000
  telemetry.flush       ->  30000 (FALLBACK)
  directory.syncX       ->  30000 (FALLBACK)   ← negative control: prefix, not substring
```

`directory.syncX` falling through is the half I did not ask for and is the one that makes
`baseTypeOf` a prefix match rather than a `startsWith`.

**RF-3 split — PASS.** `JobRuntime.js:66` claim-side `Math.max(...types.map(leaseMsFor))`, `:70`
run-side `leaseMsFor(job.type)`; RF-3a asserts the **row's** `leaseUntil`, RF-3b asserts the run
site at source with comments stripped.

**RF-3d — PASS, and stronger than specified.** Two tests: the bleed itself (`:481` — a short-lease
job claimed alongside `directory.sync` carries the longer lease) **and** `:524` proving the
run-side renewal is per type so the bleed does not persist. The second is the one that stops the
accepted behaviour from being read as a defect.

**RF-1 — PASS.** `reached === 2` before the winner check, plus `attempts === 1` as the row witness.

**RF-2 / RF-2b — PASS, and the exact delta earned its keep.** `versionsBefore + remaining`,
`event_outbox` moving with it, `checkpoint.membershipsAdded === remaining`, **and** the end state
(`TOTAL` rows, set size `TOTAL` so nothing double-wrote). The comment records that mutant MB —
worker 2 re-deriving from an empty current state — produced **18 against an expected 16** and
reddened the assertion. That is the measurement that answers QA-1's objection that
`policy_versions` cannot discriminate: an unconditional bump is exactly what makes the count
sensitive to redundant work, and only an **exact** delta sees it. RF-2b's control (`:783`) asserts
a third run's **plan** is empty, not just its counts — the right property, given #134's residual.

**RF-4, RF-5, RF-5b, RF-S — PASS.** RF-5 goes through the scheduler at a cron boundary; RF-S has
both halves (source assertion with comments stripped, plus the CALLED-detection control).

**RF-7 / RF-7b — PASS.** The guard (`applyDirectoryPlan.js:112-129`) re-checks **the claim's own
predicate verbatim** — id, workerId, `state IN (running, cancelling)`, `leaseUntil > now()` — and
the comment says why reuse is the point. RF-7 pauses *between entities* via `beforeEntity`, with a
latch so the interleaving is asserted rather than raced; RF-7b is a real control on the same code
path with an unexpired lease, and it applies. The `lease` argument being optional is correct and
correctly explained: requiring one would make direct callers invent it, and an invented lease is a
guard that always passes.

**Per-entity residual — PASS, and it names the dependency.** Ledger `:289-305`: *"the window is
not what makes it acceptable. What makes it acceptable is that every entity write is idempotent on
its natural key"*, with `upsertGroup`/`upsertUser` keyed on `(orgId, source, externalId)`, and the
warning that a **non-idempotent** write (an email, a counter, a notification) lands twice and the
guard will not stop it — *"Whoever adds such a write owns closing this window first."* That is the
condition I set, met as stated rather than as a measurement of window size. Follow-up named as
Dev5's lane after #136.

**Sync-now route — PASS on 202-idempotent, the stable key, the 404 pair, and the unregistered-Lark
pin.** The `ldap` case is the sharp one: a registered provider whose `directorySync` is false is
also 404, which separates the capability guard from a registry lookup — without it the route would
enqueue a job that fails at handler time and shows the operator 202 followed by silence.

**Ledger — PASS.** Lease as an expression on exported constants; the heartbeat mechanism
correction recorded; `320000 → 160000`.

---

## FINDING (add before merge) — the route's action string is not pinned by anything

`directorySync.js:54` gates on `requirePermission("directory.sync", orgResource)`. The deny/allow
pair (`:292`) uses **seeded `setup_admin` vs seeded `super_admin`**, and the fixture creates the
`directory.sync` permission attached to `super_admin` only.

Measured: **54 actions** are held by `super_admin` and not by `setup_admin`. So the gate could read
`audit.read`, `chat.send`, `browser-extension.write` — any of the 54 — and every assertion in that
file still passes. The test proves *"the route is gated on something setup_admin lacks"*, which is
not what it is named for.

This is the same discriminator problem #140 solved with a `system.read`-only principal, and the
same one this file's own RF-3c solved with a negative control. It is also the shape QA-3 recorded
as mutant M4 on #140: *"`action: 'system.write'` survived the first cut 6/6 green."*

```
RF-R : a principal holding ONLY `directory.sync` (a constructed role, one permission)
       gets 202, and a principal holding every other action but NOT `directory.sync`
       is refused
mut  : change the route's action string to any other action super_admin holds
why  : all 54 such mutants pass today, because the only allowed caller holds
       everything and the only refused caller holds almost nothing. A single-action
       principal is the only fixture that names WHICH action the gate asks.
```

The cheap half alone would do: grant `directory.sync` to the `setup_admin` fixture user and assert
it now gets 202. That inverts the test from "setup_admin is refused" to "the gate asks this
action", and it is three lines.

## §7.17 line

**"A deny/allow pair between two seeded roles does not pin which action a gate asks — only a
principal holding that one action does."** Measured on #138: 54 actions produce identical results.
Third instance of this class (#140 M4, #137's `system.read`-only principal, this).

## Verdict

**PASS**, conditional on RF-R. Everything else on the checklist is met, three rows are met more
strongly than I specified, and the MB measurement in RF-2b is the kind of correction that makes a
suite trustworthy rather than merely green.
