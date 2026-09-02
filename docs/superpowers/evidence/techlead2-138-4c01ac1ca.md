# Techlead-2 verdict — #138 queue/apply half `4c01ac1ca`

**Skills invoked:** `security-review` (auth tier — a lease that decides whether two workers
apply a directory sync at once). `requesting-code-review` does not resolve by name in this
session (`Unknown skill`, bare and `superpowers:`-namespaced), so the reviewer template was
read from disk. `infi-lessons` not invoked.

**Verdict on the queue/apply side: PASS. The RF-7/RF-7b discriminator is REAL — verified by
firing both mutants myself, not by reading the report. My earlier NIT (M3) is now closed by
RF-8.** The permission side is TL-1's; the gate report shows a failure there, noted below.

Worktree `/tmp/tl2-138v`, fresh database per mutant run (`t138v`, recreated from `t98b`).
**Baseline 20 passed, 20 total.** Tree clean.

---

## Is the RF-7 / RF-7b discriminator real, or the same fixture twice?

**Real. Two mutants, two different failure sets:**

| mutant | result |
|---|---|
| **M7B** — `if (false && held !== 1)`: the guard never refuses | **RF-7 red, RF-7b green** (1 failed / 20) |
| **M7C** — `if (true)`: the guard always refuses | **RF-7 red AND RF-7b red** (2 failed / 20) |

Dev3's claim is that M7C reds RF-7 with RF-7b green. **That is not what I measured, and the
difference does not weaken the discriminator — it strengthens the argument that both
fixtures are needed.** Under M7C, RF-7 fails at line 904, `expect(pausedAfter).toBe(2)`,
`Received: 0`: a guard that refuses everyone throws on the *first* entity, so worker 1 never
reaches the pause the fixture is built around. RF-7 is red for a setup reason rather than
its assertion, which is a fair failure but not the one Dev3 describes.

The property that matters holds either way, and this is the test I would apply:

- **M7B is caught by RF-7 alone** — the always-permits direction. RF-7b is green there,
  proving RF-7b cannot see it.
- **M7C is caught by RF-7b** — the always-refuses direction, and RF-7b's failure is on its
  actual assertion (a live-lease worker applied nothing).

So neither fixture subsumes the other: one direction is invisible to RF-7b, and RF-7b is
what makes RF-7 more than "a guard that refuses everything satisfies me". That is the
control relationship I have asked for since #127, and it is genuinely present.

**Correction for the ledger:** M7C reds *both*, not RF-7b alone. State it as measured. It
does not change the verdict, and the reason is worth recording — a fixture whose setup
depends on the code under test will red for setup reasons under some mutants, which is why
"which assertion failed" matters more than "how many failed".

## The apply-site guard, against my acceptability criteria

I set three conditions when this was queued. All three met:

| condition | measured |
|---|---|
| predicate is `workerId` **and** `leaseUntil > now`, at the write site | Yes — `applyDirectoryPlan.js:112-128` reuses the claim's own predicate verbatim (`id`, `workerId`, `state in (running, cancelling)`, `leaseUntil > now`). Reusing rather than re-deriving is the right call and the comment says why: a slightly different question lets through exactly the rows the claim would refuse. |
| re-checked **per entity**, not once per batch | Yes — `assertLease()` is called at six points (`:172, :181, :188, :234, :242, :253`), between entity groups, not once before the loop |
| refusal **stops** the apply rather than skipping and continuing | Yes — it throws `LeaseLostError`; there is no skip-and-continue path |

RF-7 asserts the outcome is a `LeaseLostError` **and** that `policy_versions` did not move
after worker 2 finished. The version-count assertion is the better half and the comment
gives the right reason: an idempotent re-write is invisible in a row count while still being
a write, a cache invalidation and an outbox event.

`lease` being optional (absent = unguarded) is correct for the stated reason — requiring one
would make non-job callers invent a lease, and an invented lease is a guard that always
passes. That is a real trade and it is documented rather than silent.

## My earlier NIT is closed

**M3** (remove `leaseUntil: {gt: now}` from `heartbeat`) now reds **RF-8**:

```
● #138 RF-8 (TL-2 NIT): an EXPIRED lease cannot be renewed, takeover or not
  › the original worker's heartbeat is refused once its lease has expired
```

That is exactly the fixture I asked for — expiry with **no** takeover, so the `workerId`
clause alone cannot satisfy it. Previously 9/9 green under this mutant. Closed.

## Carried items from the queue-half review

Both addressed at this SHA:

- **`leaseMsFor` exact-key gap** — RF-3c/RF-3d now cover provider-qualified types
  (`directorySyncTypeFor(PROVIDER)`), and the fixtures use them throughout, so the derived
  lease reaches the types the apply half actually enqueues.
- **`directory.sync` handler registration** — a provider-suffixed type finds its handler and
  its lease (fixture at `:541`).

## Note on the gate report (TL-1's side, not mine)

`/tmp/gate-138q.report` shows the contract step failing:

```
FAIL __tests__/security/identity/directorySyncRoute.test.js
  ● #138 R3: the gate is `directory.sync` › setup_admin is REFUSED …
FAIL __tests__/security/authorization/routeGateSweep.test.js
  ● every mounted mutating route has identity-verified authorization
  ● no mutating route carries validatedRequest alone
Tests: 3 failed, 68 passed, 71 total
```

Read the surrounding lines before treating this as a regression: STEP 9 is a **deliberate
mutant** (`requirePermission("directory.sync", orgResource)` → passthrough), and these three
failures are that mutant being caught, which is the step passing. `GIT_STATUS_AFTER_MUTANT=[]`
confirms the tree was restored. The genuine failure is at STEP 10/11 —
`TASK_CHECK_EXIT=1`, `check ไม่ผ่าน`. That is the permission lane; TL-1 owns it. My side's
20/20 is unaffected.

## Reproduction

```
git worktree add --detach /tmp/tl2-138v 4c01ac1ca
cp -al <donor>/server/node_modules /tmp/tl2-138v/server/node_modules
cd /tmp/tl2-138v/server && npx prisma generate
psql -c 'DROP DATABASE IF EXISTS t138v WITH (FORCE)' -c 'CREATE DATABASE t138v TEMPLATE t98b'
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       JWT_SECRET=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t138v"
npx jest __tests__/security/jobs/directorySyncConcurrency.test.js --runInBand
```

Database recreated from the template before every mutant run — a reused database changes the
failure counts (measured on #135 in the same session).

---

## Correction (Techlead-2, after Dev3's ledger `d912e3a28`)

**Dev3 is right: the mutant LABELS in the section above are transposed, and my "correction
for the ledger" was spurious. Withdrawn.**

Re-fired both by behaviour rather than by name, fresh database before each:

| mutation | behaviour | result |
|---|---|---|
| `if (true)` | refuses everyone | **RF-7 red** at `pausedAfter` `Expected: 2 / Received: 0` (setup-reason) **AND RF-7b red** — 2 failed / 20 |
| `if (false)` | admits everyone | **RF-7 red** at `Expected constructor: LeaseLostError / Received constructor: Object`, **RF-7b green** — 1 failed / 20 |

That is exactly what Dev3's ledger reports. My measurements were correct; my **names** for
them were not — I called the admits-everyone mutant M7B and the refuses-everyone mutant
M7C, which is the reverse of Dev3's naming. Everything I then wrote about "M7C" reding both
was therefore describing the refuses-everyone mutant under the wrong label, and my claim
that Dev3 had mis-reported it was wrong. Dev3 reported it accurately.

The setup-reason red belongs to **refuses-everyone**, as Dev3 says: a guard that refuses on
the first entity means worker 1 never reaches the pause the fixture is built around.

**The verdict and the discriminator finding are unchanged**, and if anything the naming fix
makes them cleaner:

- **admits everyone** → caught by RF-7 alone, on its real assertion (`LeaseLostError`
  expected, plain object received), with **RF-7b green** — so RF-7b provably cannot see
  that direction.
- **refuses everyone** → caught by RF-7b on its real assertion.

Neither fixture subsumes the other. That was the question asked and the answer stands.
