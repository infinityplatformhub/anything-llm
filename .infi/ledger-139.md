# Ledger — #139 (Node version guard, plain tier)

Dev2. Branch `i139-node-guard` off `approof/main` @ `d5fda7255`.
Lane: `frontend/package.json`, `frontend/scripts/check-node-version.mjs`,
`frontend/.nvmrc`, `server/.nvmrc`. Nobody else in these files.

---

**Ruling: the contract's RED was wrong, and I corrected it rather than
reproducing it.** — The dispatch said "on node 26 `yarn test` today runs vitest
and shows the TypeErrors". Measured: it does not. `engines: ">=22 <23"` is
already enforced by yarn, so `yarn test` on Node 26 exits before vitest starts
with `error ... Expected version ">=22 <23". Got "26.0.0"`. The two routes that
*do* reach the TypeErrors, both measured, are `yarn --ignore-engines test` and
invoking vitest directly (editor runners, a CI step calling the binary). The
guard is written for those. — **If I had built to the stated RED I would have
shipped a guard whose only demonstration was a path that was already closed, and
the evidence would have looked identical.**

**Ruling: M3 cannot be killed by an exit code; the kill signal is the TypeError
count.** — Mutating `process.exit(1)` → `process.exit(0)` leaves `yarn test`
exiting 1 anyway, because vitest then runs and fails on its own. Exit-code-only
verification reports the mutant dead while the guard has stopped guarding.
Measured: M3 produces 33 TypeErrors in the output where the unmutated guard
produces 0 real ones (1 textual match, which is the guard's own message quoting
the error string). — **If wrong, a later refactor drops the exit status and the
suite still "passes" its mutation check.**

**Ruling: `.nvmrc` said `v18.18.0` in both `frontend/` and `server/`; changed to
22 to match `engines` and CI.** — Not in the original dispatch; found while
verifying my own earlier report, which had claimed `.nvmrc` said 22. It does at
the repo root, and I had read that one. All four `package.json` files declare
`>=22 <23` and `ci.yml` pins `node-version: "22"`, so `nvm use` inside either
package selected a Node three majors below what the code requires. — **If
wrong, someone follows `.nvmrc`, lands on Node 18, and hits a different wrong
runtime — the same confusion the guard exists to make legible, arriving from the
opposite direction.**

---

## Evidence

```
node 26.0.0, yarn --ignore-engines test  → exit 1, guard message printed,
                                           vitest never starts (0 TypeErrors)
node 22.23.1, yarn test                  → exit 0, Tests 107 passed (107)
                                           baseline before the change: 107
```

## Mutants

| # | mutation | result |
|---|---|---|
| M1 | `if (false)` — guard disabled | node 26 runs vitest again, **32 TypeErrors return** |
| M2 | `REQUIRED_MAJOR = 20` | node 22 now refused — proves it reads the running version, not a constant |
| M3 | `process.exit(0)` | exit stays 1 (vitest's own failure); **33 TypeErrors reappear** — killed by count, not by exit code |

## Correction made in-flight

My first report to the PMO stated `frontend/.nvmrc` was 22. It was `v18.18.0`; I
had read the root `.nvmrc`. Corrected in the same message thread and fixed in
this branch.
