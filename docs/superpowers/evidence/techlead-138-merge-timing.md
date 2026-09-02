# Techlead-1 — #138 merge timing: **(a) merge now**

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
unreachable-surface risk, privilege boundary of the exposed route. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in a detached worktree (`/tmp/tl-comb` at `27e60402e`).

---

## Ruling: **(a) — merge #138 now, Dev3 starts #141 immediately.**

QA-2's measurement is right and the code already documents it: `directorySync.js:64-71` states the
gap in the route itself — *"`lark` is not in the registry… so this route answers 404 for the very
provider the sync was built for… Special-casing it here would put provider configuration in a
route, where nobody would look for it."* A defect the code names, with the follow-up named beside
it, is a declared residual rather than a surprise.

**Two measurements that decide this:**

**There is no button.** `grep identity/directory frontend/src` returns nothing — no UI entry
exists. So option (c) is a no-op: there is nothing to hide, and adding a flag to hide a control
nobody built is code written to satisfy a concern rather than a user. The exposed surface is one
authenticated POST behind `directory.sync`, which the seed grants to `super_admin` alone.

**Nothing fires on a schedule either.** `registerCoreSchedules` registers `retention-purge-daily`
only; no `directory.sync` schedule is registered at boot. So merging exposes no background
behaviour — the handler exists, the lease map knows the type, and nothing enqueues one.

**Against (b), holding until #141:** the queue half is 15/15 with three mutants caught and is the
part that carries the concurrency guarantees — the lease protocol, the takeover convergence, the
per-entity guard. Holding it back does not make it safer; it leaves a reviewed, tested body of work
unmerged while a second branch grows on top of it, and #141's own recon says it *depends on #138's
queue merge* because it registers the driver whose constructor signature #138 was moving. Holding
inverts a dependency both sides have already agreed on.

**Against (c) specifically as a pattern:** hiding a control to conceal an unreachable backend is
how a gap stops being visible before it stops being real. The 404 is the honest behaviour — it
names the missing capability, distinguishes an unregistered provider from a non-syncing one
(`ldap` is 404 too, and the test asserts it), and is pinned by a test so #141 turning it into a 202
is a deliberate, observed change.

## One condition

**The residual must be stated where an operator reads it, not only in the ledger.** The route
comment is for the next developer; the issue's residual section is for whoever deploys this. One
line: *"`POST /identity/directory/:provider/sync` answers 404 for every provider until #141
registers Lark. No directory sync runs on this build."*

That is the same disposition as #138's injected-driver seam (`c55bbbe2d`), and the same reason: an
over-claim in a changelog is worse than the gap itself, because the gap is temporary and the
sentence "Lark directory sync shipped" is not.
