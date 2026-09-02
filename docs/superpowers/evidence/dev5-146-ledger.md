# Dev5 — #146 ledger: CI's postgres service must ship pgvector (plain tier)

**Skills invoked:** `test-driven-development`; `verification-before-completion`.

Branch `approof/146-ci-pgvector` off `origin/approof/main` @ `f10688efc`.

---

## Rulings

Ruling: `.github/workflows/ci.yml:16` moves from `postgres:16` to
`pgvector/pgvector:pg16`, and nothing else changes — because stock `postgres:16` does
not ship the `vector` extension, so any check or suite that needs it can only be
skipped or red in CI while passing for every developer whose local container has it
— if wrong, the failure is remote-only and asymmetric, which is the most expensive
kind to diagnose.

Ruling: the change gets a TEST, even though it is one line of YAML — because the
workflow is executed only by GitHub and no suite in this repo reads it, so a revert to
`postgres:16` would be witnessed by nobody — if wrong, the line is deleted by a future
reader as an unnecessary detail and CI silently returns to the state this issue fixed.
Same shape as #142's `30_000`, and the same reason it needed a guard rather than a
comment. (Dispatch rule applied: a dev-found fix needs a test.)

Ruling: the guard asserts the image MATCHES /pgvector/, not an exact tag — because the
tag will move (`pg16` → `pg17`) and pinning the literal would go red on a correct
upgrade — if wrong, the guard fires on good work and gets removed within a week.

Ruling: the guard matches the POSTGRES service's image line specifically
(`/postgres:\s*\n\s*image:\s*(\S+)/`), not any `image:` in the file — because the
workflow also names chroma, qdrant, weaviate and milvus images and a loose match would
pass on one of those while postgres was reverted.

---

## Evidence

```
contract  DATABASE_URL -> a pgvector container
          node ./node_modules/.bin/jest __tests__/scripts/doctor.test.js
          -> Tests: 46 passed, 46 total   Test Suites: 1 passed
guard     __tests__/utils/test/ciPostgresImage.test.js -> 1 passed
```

### Mutant

| mutation | result |
|---|---|
| revert `ci.yml:16` to `image: postgres:16` | **1 red** (the guard) |

`doctor.test.js` is 46/46 on BOTH images — measured, and worth stating plainly rather
than implying the contract witnesses the change. It does not: `requiredExtensions`
demands `vector` only when `VECTOR_DB=pgvector`, and its extension fixtures use
`citext` and skip when a server does not ship what they need, precisely so a developer
without pgvector sees green. So the contract proves the new image breaks nothing; the
guard is what holds the change in place. Those are two different jobs and only one of
them is a witness.

## Residual — TL-1's "observe red→green in CI" is NOT satisfied

The condition asks for a CI run on the pushed branch. **I have not pushed**, and I am
not going to without being asked: pushing publishes the branch to
`infinityplatformhub/anything-llm` and starts a workflow, which is an outward-facing
action, and my standing instruction on this program is SHA-only, no push. `gh run list`
returns empty here, so no prior run is available to point at either.

PMO: say the word and I push, or push it yourself from the PMO session — either way
the run URL belongs in this file before #146 closes. Recorded as an open condition
rather than quietly marked done.
