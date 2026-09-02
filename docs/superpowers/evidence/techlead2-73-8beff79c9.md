# Techlead-2 review — #73 `8beff79c9` (rebased on `c7ef9d28`; pre-read was `a42b3f0`)

**Verdict: PASS.** The blocker is fixed and I confirmed the fix against the newly pinned
image; both notes are addressed, and the NOTE-2 rework is better than what I asked for. Every
guard I could think to attack held, in both directions.

Independent worktree `/tmp/tl2-73b`, `node_modules` hardlink-copied from `/tmp/qa1-40`,
`prisma generate` run, Node v22.23.1. My own engines: PostgreSQL 16 `:55472`, Qdrant v1.9.0
`:56333`, Weaviate 1.24.10 `:58080`, Milvus v2.3.9 `:19531`, plus a fresh
`chromadb/chroma:1.0.0` on `:58100` started specifically to test the new pin. Per §7.14 I ran
no full-directory suite — only the real-store suites, the guard test, and mutations against
them. Worktree clean; every mutation restored from a backup.

---

## BLOCKER-1 — fixed, and the endpoint claim in the comment is exactly right

I measured both images myself rather than taking the comment's word for it:

```
chromadb/chroma:0.5.5   /api/v1/heartbeat -> 200    /api/v2/heartbeat -> 404
chromadb/chroma:1.0.0   /api/v1/heartbeat -> 410    /api/v2/heartbeat -> 200
```

That matches the comment in `ci.yml` line for line. The 410 on v1 is the detail that makes
the pairing load-bearing: the old readiness URL against the new image would never go ready, so
bumping the image without bumping the probe fails loudly rather than silently — the opposite
of the failure being fixed, which is the right direction for the mistake to fall.

The suite against the newly pinned image:

```
CHROMA_TEST_ADDRESS=http://127.0.0.1:58100  →  Tests: 8 passed, 8 total   EXIT=0
```

On `a42b3f0` the same suite gave `8 failed` with `ChromaNotFoundError:
/api/v2/tenants/default_tenant`. Closed.

## NOTE-1 — addressed as a comment, which is the correct scope

`ci.yml` now carries an explicit instruction above `yarn test` not to add a path or `-t`
pattern, with the reason. I verified the underlying behaviour is unchanged and still correct:

```
CI=true npx jest realStoreSuites   →  EXIT=0
[#73] filtered run — skipping the real-store presence check (a subset run cannot prove absence)
```

A filtered run genuinely cannot prove absence, so standing down is right. The residual risk is
that someone edits the command; a comment at the point of edit is the appropriate fix, and
making the reporter fail on filtered runs would break every developer's targeted run for no
security gain.

## NOTE-2 — reworked into a fixture-driven rule, and it is stronger than what I asked for

I asked for a fixture proving the exemption branch fires. Dev4 went further and **extracted
the rule into a pure function** (`undeclaredExemptions(exempt, workflowText, residualsText)`),
then drove it with three cases: declared in neither, declared in the workflow only, declared in
both. The live check against today's empty `CI_EXEMPT` remains as a separate test.

That is better because the rule is now executable independently of the data. My version would
have proven the branch runs; this proves the rule is *correct*, including the middle case —
declared in the workflow but not in the risk register — which is the one a real exemption is
most likely to land in.

Mutation-verified, both directions:

| mutation | result |
|---|---|
| `undeclaredExemptions` checks the workflow only, not residuals | **1 failed** |
| `undeclaredExemptions` always returns `[]` (rule dead) | **1 failed** |

The comment placed above it names the defect class and cites QA-1's M7 on slice 2 — *"an
assertion made against data that cannot exercise it is an assertion that the fixture is
empty"*. Recording the class rather than the instance is what stops it recurring in the next
file.

## The guard itself — attacked from four directions, held on all four

| what I did | result |
|---|---|
| all four engines up (positive control) | `EXIT=0`, `[#73] all 4 real-store suites executed against a live engine`, **42 passed** |
| one engine unreachable (`CHROMA_TEST_ADDRESS` unset — the "service block deleted" case) | **`EXIT=1`**, `chromaRealStoreAcl.test.js ran 0 passing tests (8 skipped)` |
| `CHROMA_TEST_ADDRESS` deleted from `ci.yml` | **1 failed** — "the workflow sets every variable the listed suites need" |
| reporter unregistered from `jest.config.js` | **1 failed** — "the reporter that proves execution guards exactly these suites" |

The second row is the RED the issue exists for, and it fires with the exact diagnosis an
operator needs: which suite, how many tests were skipped, and that the predicate was never
executed against a real store. The third and fourth are the two ways someone would break this
without touching the reporter's logic, and both are caught by the guard test rather than only
by the reporter — so the failure lands at PR review time, not on the CI run after it merged.

Combined with the pre-read result I already reported (a `--testMatch` narrowed to just the
guard test still exits 1, because the reporter sees the four files missing from the result
set), every bypass I could construct is closed except the one that is documented and
deliberate.

## Correct, briefly

- The reporter sets `process.exitCode` rather than throwing, with the reason recorded — a
  throw from a reporter is swallowed in some jest versions, and this must not fail quietly.
- `EXEMPT_IN_CI` and `CI_EXEMPT` are both empty, so all four engines are required today. The
  drift between the two lists is itself asserted by "the reporter guards exactly these suites".
- The compose file pins every image, uses `depends_on: condition: service_healthy`, and passes
  `milvus run standalone` as a command — all three of which `services:` cannot express. This
  matches what I measured on this machine during the slice 1b review, where `docker run --link`
  failed outright and Milvus only came up after etcd and MinIO were started on an explicit
  network first.
- Readiness waits run on the runner, not as container health checks, because the qdrant,
  weaviate and milvus images ship without curl. The reasoning is recorded in the workflow.
- Milvus is probed with `/dev/tcp` because 19530 speaks gRPC, and the comment says plainly
  that this is weaker than the other three and that the suite's own `connect()` is the real
  proof. An honest statement of a check's limit is worth more than a stronger-looking check
  that is not.

## Reproduction

```
git worktree add --detach /tmp/tl2-73b 8beff79c9
cp -al /tmp/qa1-40/server/node_modules /tmp/tl2-73b/server/node_modules
cd /tmp/tl2-73b/server && npx prisma generate
docker run -d --name tl2-c100 -p 58100:8000 chromadb/chroma:1.0.0
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=a SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t5" \
       CHROMA_TEST_ADDRESS=http://127.0.0.1:58100 QDRANT_TEST_URL=http://127.0.0.1:56333 \
       WEAVIATE_TEST_URL=127.0.0.1:58080 MILVUS_TEST_ADDRESS=localhost:19531
CI=true npx jest --testMatch="**/__tests__/security/authorization/{realStoreSuitesRunInCi,chromaRealStoreAcl,qdrantRealStoreAcl,weaviateRealStoreAcl,milvusRealStoreAcl}.test.js"
```

Drop `CHROMA_TEST_ADDRESS` from that environment to see the RED. The two file mutations were
applied to working copies of `ci.yml` and `jest.config.js` and restored immediately after.
