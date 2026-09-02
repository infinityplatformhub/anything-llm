# Dev5 — #149 ledger: PR #148's CI failures (plain tier)

**Skills invoked:** `systematic-debugging` (the dispatched diagnosis did not match the
logs); `test-driven-development`; `verification-before-completion`.

Branch `approof/149-ci-env` off `approof/146-ci-pgvector` @ `e66ccbebd`.
Three commits: `c8dcab465` (prettier), `2b714f8e6` (eslint + env assertion),
`75d30834e` (workflow deletion + trigger widening).

---

## Rulings

Ruling: the dispatched diagnosis was wrong and I said so before editing — the P1012 is
in `.github/workflows/run-tests.yaml`, NOT `ci.yml`, and `ci.yml` already declares
`DATABASE_URL`/`API_KEY_PEPPER` at job level — because I read the five failing jobs
from PR #148 rather than the summary — if wrong, I would have "fixed" a file that was
already correct and left the failing one untouched, and the next CI run would have
failed identically with a commit claiming to have addressed it. (PMO confirmed and
corrected the issue body.)

Ruling: `run-tests.yaml` is DELETED, not repaired — because it has no postgres service
and no env block, so adding env only moves the failure from P1012 to a connection
refusal; it starts no database. Its root `yarn test` covers nothing this fork runs and
collector has no tests — if wrong, the fork carries two workflows running the same
suite, which is how they drift apart. (TL-1 `d410f46ee`.)

Ruling: deleting it forces `ci.yml`'s `branches: ["approof/main"]` restriction to go
too, in the SAME commit — because with the second workflow gone `ci.yml` is the only
backend test run, and a PR into any other branch previously got no run at all and
merged on a green checks page that had tested nothing — if wrong, the gap is invisible
precisely because the page is green.

Ruling: widened to every pull request rather than given a branch pattern — because any
pattern encodes today's naming, and the branch nobody remembers to add is the one that
needed the run. Noise is bounded by the existing `concurrency` group, which cancels
superseded runs.

Ruling: `__testHelpers__` gets `globals.jest` rather than being added to `ignores` —
because several suites import these helpers, so a dead variable or a bad import there
breaks callers, whereas a suite is self-contained. What they needed was the
environment, not an exemption. (TL-1's ruling; my first attempt was `ignores` and it
was the weaker choice for exactly this reason.)

Ruling: `STORAGE_DIR` is NOT asserted in the env test, despite being named in the
dispatch — because it is absent from `ci.yml` today and every suite that needs one
creates its own temp directory, so the suite passes without it — if wrong, the guard
demands a variable nothing reads, and a guard that fires on correct configuration is
deleted along with the assertions that mattered.

---

## What CI actually reported — three causes, not one

| job | reported as | actually |
|---|---|---|
| `run-script` (Run backend tests) | "ci.yml env at wrong level" | P1012 in `run-tests.yaml`, a different workflow with no service and no env |
| `lint-server` | "pre-existing prettier drift" | 60 × `'jest' is not defined` (no-undef) in `__testHelpers__` — a config gap; `prettier --write` fixes none of them |
| `lint-frontend` | prettier drift | correct — 43 files |

## Evidence

```
lint-server   'jest is not defined' count   before: 60   after: 0
              (total errors 1072 -> 1063; the remainder is pre-existing drift
               across the tree, measured on origin/approof/main at 1072 — NOT
               introduced here and NOT in this issue's scope)
lint-frontend prettier --check src          only src/index.css remains, untouched
              (a pre-existing CSS formatting difference, not among the 43 flagged)
guard         ciPostgresImage.test.js       3 passed
```

### Mutants

| # | mutation | result |
|---|---|---|
| M1 | drop `DATABASE_URL` from the job env block | **1 red** |
| M2 | remove the job-level `env:` block | **1 red** |
| M3 | revert the image to `postgres:16` | **1 red** |

The env assertion is anchored to the JOB's indentation (`\n {4}env:`). Its CONTROL
proves the matcher rejects the postgres SERVICE's own `env:` block — that block sits at
deeper indentation and contains `DATABASE_URL`-shaped lines, so a looser matcher would
report the job as configured while it had nothing, which is the exact failure this file
exists to prevent.

## Residual

`server` lint is 1063 errors, essentially all pre-existing `prettier/prettier` drift
across the tree (1072 on `origin/approof/main` before this branch). `lint-server` will
stay red until someone runs `--fix` over the server tree, which is a whole-tree
formatting commit and a different issue. This branch removed only the class CI
attributed to #146. Stated rather than left for the next person to discover from a red
check.
