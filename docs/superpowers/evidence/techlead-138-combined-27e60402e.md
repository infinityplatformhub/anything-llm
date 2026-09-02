# Techlead-1 — #138 combined `27e60402e`: accept; and the RF-3d inheritance ruling

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization gate coverage, fixture masking a seed regression. `infi-lessons` not invoked.

§7.14: no suite run. Source reads in a detached worktree (`/tmp/tl-comb` at `27e60402e`).

---

## The three deltas: **accept, no objection.** One of them is better than what I passed

**Route pin 320 — correct, and the comment is the valuable part.** Both branches independently
wrote 319 for their own route, which is exactly how a merge produces a wrong total that looks
right on each side. The line says so, and says the resolution is **measured, not
`318 + 2`** — *"a pin that is arithmetic rather than observation is how two correct-looking halves
produce a wrong total."* That is the right disposition and it is written where the next merge
conflict will be read.

**`create` → `upsert` on the fixture — this is an improvement I did not ask for and would not
have caught.** Under `create`, the fixture re-granted `directory.sync` to `super_admin`
unconditionally, so **a seed that stopped granting it would leave R1 green** — the fixture would
have been standing in for the thing under test. With `upsert`, the suite runs against whatever the
real seed produced and R1's 202 goes red instead. The comment also states the limit correctly: this
suite still does not prove a *seed-only* install holds the grant, and points at
`directorySyncPermission.test.js` as the right home for that. Naming what a test does **not** cover
is the half most fixtures omit.

**RF-R premise assertion — correct, and necessary rather than decorative.** `expect(preexisting).toBeNull()`
before the grant: without it, if the seed ever gave `setup_admin` the action, the opening 403 would
come from somewhere else and the grant would change nothing, leaving RF-R green while proving the
opposite of its name. The comment gives that reason — *"the seed decides this and the seed is not
this suite's to control"* — which is precisely why a fixture must assert its own premise.

**Accept. #138 combined is a PASS from me.**

## RF-3d / JobRuntime lease inheritance: **accept the shared claim lease. Do not go per-type.** (ruling, carried twice — settling it here)

`JobRuntime.js` claims every registered type in one call at
`Math.max(...types.map(leaseMsFor))`, so once `directory.sync` registers, a `telemetry.flush` job
is written with a 160s `leaseUntil` and only shrinks at its first heartbeat. QA-1's residual is
real: a worker dying between claim and first beat leaves a 30s job unclaimable for 160s.

**Accept, and the reason is not "the cost is small" — it is that the two error directions are not
symmetric.** The claim lease's only job is to be *long enough*. Too long costs a bounded delay
before a **dead** worker's job is retried. Too short lets a second worker claim a job whose first
worker is **alive and mid-apply** — a concurrent directory apply, which is the failure this entire
slice exists to prevent. `Math.max` errs in the safe direction by construction; a per-type claim
errs in the unsafe one whenever the map and the claim disagree.

Per-type claiming buys the 130s back at the cost of either N round trips per tick or a claim that
reasons about mixed leases inside one transaction — real complexity, in the one code path where a
mistake produces two concurrent applies.

**Both conditions already met on this SHA**, which is why this is a ratification rather than a
request: the tick comment states that non-sync types wear the maximum until their first heartbeat
and why, and RF-3d pins a `telemetry.flush` row's `leaseUntil` to the directory-sync value with
`directory.sync` registered — so the accepted behaviour is held in place by a test rather than by a
comment, and a future move to per-type is a deliberate revisit instead of drift. The companion test
proving run-side renewal is per type is what stops the inheritance being read as a defect.

**Residual, to be recorded once and then closed:** *"A job type with a short lease inherits the
longest registered lease for its claim window, until its first heartbeat. Accepted: the claim lease
must be long enough, and erring long delays takeover of a dead worker while erring short permits a
concurrent apply."* No follow-up issue — this is a decision, not a deferral, and carrying it as an
open residual invites a third round.
