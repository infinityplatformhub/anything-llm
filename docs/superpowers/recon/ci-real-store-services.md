# CI: add milvus / qdrant / weaviate / chroma services

Split out of #30 (T-5 vector ACL) by PMO ruling. Type: change.

## What CI does today

`.github/workflows/ci.yml` sets exactly two environment variables:

```yaml
env:
  DATABASE_URL: postgresql://approof:approof@localhost:5432/approofworkspace_test
  API_KEY_PEPPER: ci-only-api-key-pepper-32-bytes-minimum
```

Every real-store suite added by #30 gates itself on an address that is never set:

| Suite | Guard | Env var |
|---|---|---|
| `milvusRealStoreAcl.test.js:42` | `describeIfMilvus` | `MILVUS_TEST_ADDRESS` |
| `qdrantRealStoreAcl.test.js:33` | `describeIfQdrant` | `QDRANT_TEST_URL` |
| `weaviateRealStoreAcl.test.js:52` | `describeIfWeaviate` | `WEAVIATE_TEST_URL` |
| `chromaRealStoreAcl.test.js:26` | `describeIfChroma` | `CHROMA_TEST_ADDRESS` |

Unset means `describe.skip`, so **all four suites are skipped in CI and always have been.**
Jest reports the run as green. Nothing in the output distinguishes "these 36 tests passed"
from "these 36 tests did not run".

## Why this matters more than a normal coverage gap

These are not incidental tests. They are the only tests that have ever caught this class of
bug, and they have caught it five times:

| Provider | Defect | Visible by reading? |
|---|---|---|
| LanceDB | bare identifiers case-folded by DataFusion; the standard-SQL `"orgId"` form parses and returns **0 rows, always** | no — reviewed and approved |
| pgvector | placeholder numbering off by one (`next()` read `params.length` without pushing) | no |
| Milvus | `not exists a and not exists b` fails to parse; needs individual parens | no |
| Qdrant | `is_null` does not match an **absent** key, which is what every pre-T-5 point has | no |
| Weaviate | `word` tokenization over-denies — `NotEqual "doc-bad"` also drops `"doc-good"` | no |

Each predicate read correctly. Each passed review. Each was rejected or silently mis-applied
by its engine on first contact. The failure mode is the dangerous one: a predicate that
returns zero rows looks identical to a working ACL until someone notices retrieval is empty
— or, in the tokenization case, until a document that should be readable quietly is not.

So CI is currently green without executing the only checks that have ever failed for a real
reason on this code. A gate that has never been red is not yet shown to stop anything —
the same shape as the two precedents in the skill's rationalization table (`check-local`
skipping a whole language for want of `chmod +x`; `claude plugin validate` passing "cleanly"
with no `SKILL.md` in the system).

## Proposed change

1. Add four `services:` blocks to the `test` job, each with a health check, following the
   existing `postgres` block's shape.
2. Add the four environment variables pointing at them.
3. **Add a guard test that fails when a real-store suite skips in CI.** Without it this
   regresses silently the moment a service is renamed or a health check starts failing —
   which is precisely the current bug, one layer up. Suggested shape: assert that when
   `CI=true`, each of the four variables is set.

Point 3 is the part that must not be dropped. Adding the services fixes today; the guard is
what keeps them fixed, and its absence is the actual root cause of this issue rather than
the missing services themselves.

## Evidence contract

Adding services proves nothing by itself — the suites could still skip. The contract is that
the four suites actually **run**:

```
cd server && yarn test 2>&1 | grep -E "^(Tests|Test Suites):"
```

with the expectation that no real-store suite reports as skipped. In practice: assert the
skipped count for those four suites is zero, not merely that the overall run is green. That
distinction is the whole issue.

## Cost / risk

- CI wall-clock grows by the four containers' startup (Milvus is the slow one — it needs
  etcd and MinIO, so it may warrant a compose file rather than bare `services:`).
- Milvus's multi-container dependency is the one genuine complication; if it proves
  impractical in Actions, the honest outcome is to run three in CI and keep Milvus
  developer-run **with that stated in the workflow**, rather than leaving all four silently
  skipped.

## Not in scope

- pinecone and astra are hosted-only, have no local instance, and stay UNVERIFIED with the
  existing boot warning (PMO ruling, recorded in `docs/superpowers/residual-risks.md`).
  Nothing in CI can cover them; that is a separate accepted risk, not something this issue
  can close.
