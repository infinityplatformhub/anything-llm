# Phase 0 gate checklist

What must be true before Track V fan-out opens month 2. Baseline for every number
below: `approof/main` @ `54db4028`.

A criterion belongs here only if a command decides it. "Reviewed and looks fine"
is not a gate — the whole point is that the gate can be re-run by someone who was
not in the room.

---

## 1. Issues that must be merged

| # | Track | What closing it proves | State at `54db4028` |
|---|---|---|---|
| #15 | E2E | 12 scenarios green headed against a real stack | 14 `test()` blocks on `7e6ed3bb`; see §4 |
| #26 | PR-4b(3), (4) | Last 22 wildcard routes carry named scopes | counter at 22 (was 52) |
| #27 | PR-4c | No key can be minted with `*` | not started |
| #25 | T-4a | Role literals gone from internal routes | GREEN in progress |
| #29 | T-4b | Jobs + embed + `/v1` wired to the engine | not started |
| #30 | T-5 | Vector queries filter by ACL — **the one that matters most** | not started |
| #28 | T-6 | Audit export + retention + redaction | not started |
| #31 | T-7 | Admin duties separable | not started |

Merge order is fixed by file overlap, not by importance: **4b-3/4b-4 → T-4a → T-4b → T-5 → T-7 → PR-4c**. PR-4c is last on purpose — it removes `*` from keys, and every route must already want a named scope before that is safe (see `.infi/recon/pr4c.md`).

T-6 is off the critical path and can land any time after T-4b.

---

## 2. Criteria a command decides

Run from the repo root on the merge candidate. Each row is pass/fail, no judgment.

### 2.1 API key scopes

```bash
grep "EXPECTED_WILDCARD_ROUTES =" server/__tests__/utils/middleware/apiKeyWildcardSweep.test.js
```
**Must read 0**, and the sweep test must still pass — the counter and the code are checked against each other by the test itself. At `54db4028` it reads 22.

When it reaches 0, delete `API_KEY_SCOPES.TEMPORARY_ALL` and the sweep test in the same PR. A counter that can only ever read 0 is not a gate any more.

```sql
SELECT count(*) FROM api_keys WHERE scopes::jsonb ? '*';
```
**Must be 0** on a database that has run every migration and had a key minted through each creation path. Run it against a real Postgres — the DB default is the thing under test, and a fake db reports whatever the model sent (code-standards §7.1).

### 2.2 Role literals

```bash
git grep -c 'ROLES\.' -- 'server/**/*.js' | awk -F: '{s+=$2} END {print s}'
git grep -l 'flexUserRoleValid' -- 'server/**/*.js' | wc -l
git grep -l 'strictMultiUserRoleValid' -- 'server/**/*.js' | wc -l
git grep -nE 'role (===|!==) "(admin|manager|default)"' -- 'server/**/*.js' | grep -v __tests__
```

**All four must be 0** outside `server/utils/authorization/`. At `54db4028`: 185 refs, 27 files, 2 files, 2 sites.

The fourth grep is not redundant. `utils/chats/commands/img.js:55` and `utils/helpers/documentPurgeGuard.js:33` compare `user.role` to a string literal and never import `ROLES`, so the first grep cannot see them. Both are named in the P0-5 DoD and both are still present.

### 2.3 Frontend capability gates

```bash
git grep -l '"admin"\|"manager"\|"default"' -- 'frontend/src/**/*.jsx' | wc -l
```

32 files at `54db4028`. These are UI affordances, not a security boundary — but they all evaluate false once the legacy role column stops being written, so **a real admin stops seeing the admin UI**. This ships in the same release as T-4a or the product is broken for its own operators. It is a gate item because it is the failure that looks like a bug report, not like a security finding.

### 2.4 Vector ACL — the load-bearing one

`ENABLE_DOC_VECTORS_CANONICALIZE` must be set **and** every legacy-uuid call site migrated. The job refuses to run otherwise, by design:

```bash
grep -n "CanonicalizeNotEnabledError" server/jobs/docVectorsCanonicalize.js
git grep -n "DocumentVectors.where\|deleteForWorkspace\|removeDocuments" -- 'server/**/*.js' | grep -v __tests__ | wc -l
```

20 call sites across 8 providers at `54db4028`. The guard comment in `docVectorsCanonicalize.js:14-20` states the failure precisely: after the job rewrites `document_vectors.docId` to canonical ids, any caller still looking up by legacy uuid **silently matches nothing**, so deleting a document leaves its vectors behind and they stay answerable. Silent, not loud.

**Gate: the enable flag is only set after the last of those 20 sites moves, and the vector-leak test passes with the flag on.** Setting the flag earlier turns a refusing job into a corrupting one.

The vector-leak test itself (P0-5 DoD item 8): two users, documents with disjoint ACLs, a question answerable only from the other user's document → must not be answerable. This is the single most important test in Phase 0. It gates on its own.

### 2.5 Suite stability

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export DATABASE_URL="postgresql://…"   # real Postgres, per code-standards §7.0
export API_KEY_PEPPER="…"              # ≥32 bytes
cd server && yarn test
```

**Three consecutive full runs, same pass count, zero flakes.** Three, not one — the known flakes in `.infi/residual-risks.md` are all intermittent and a single green run does not distinguish "fixed" from "lucky".

Two are recorded and unowned:
- `modelPricing/index.test.js` etag `""` vs `"abc123"` — shared temp cacheDir across suites
- `engine.test.js` + `t1-authz-migration.test.js` `afterAll` DROP DATABASE under the default 5000ms hook timeout while `beforeAll` gets 300_000

The second has a known one-line fix (pass a timeout to `afterAll`) that has been dropped from two branches already. **It needs an owner before the gate, not a mention.**

Without both env vars, six suites fail at import time and are counted as *failed*, not skipped — the `Tests:` line silently shrinks. A reviewer who forgets them reads a smaller green number as success.

### 2.6 Repo standards

```bash
./scripts/check-local.sh
bash <path-to>/task.sh check --base approof/main --issue <n>
```

Both must pass on the merge candidate. `check-local.sh` currently runs the §5.1 model-import gate; anything added later is picked up automatically.

### 2.7 Residual risks have owners

Every line in `.infi/residual-risks.md` must carry either an issue number or an explicit "accepted, revisit at X" ruling. See §3 — this is not true today.

---

## 3. Open holes with no issue

Read from `.infi/residual-risks.md` at `54db4028`. Ordered by what happens if the gate opens without them.

### 3.1 Blocking

**Two known flakes, no owner.** Both listed in §2.5. The DROP DATABASE race is explicitly marked `[flake, unowned]` and has been dropped from two branches. §2.5 cannot be satisfied while it is live: it fails intermittently, so a three-run gate will catch it and stall the gate at the worst moment.

**`document_acl` org-wide kill switch.** A row with `principal_type=workspace`, `principal_id="*"` denies for every org-wide actor — anyone with ACL write can deny the entire org in one row. Marked `[T-4b/T-5]`, fix is to replace the `"*"` sentinel with `orgWide:true` and write the rule into seam 07 **before** T-5 wires drivers. If T-5 lands first, the sentinel is baked into every provider.

**Node 26 incompatibility.** `jsonwebtoken@9.0.2` fails to load on Node 26 (SlowBuffer), runtime path `utils/http/index.js:4`. Baseline is Node 22. Marked "must be answered before any CI/Docker moves to Node 26". Not a code fix — a decision about what the release targets. If CI moves first, everything breaks at once and the cause looks unrelated.

### 3.2 Should have an issue before fan-out

**`authorizeMany` batch cap.** 0.176ms/resource, linear, no cap. Recon §W-6 caps at 500 inside T-4a; the residual note says "any HTTP endpoint that exposes it", which is broader than T-4a's file set. Confirm T-4b covers the `/v1` side.

**`actorResolver` checks `revokedAt` but not `expiresAt`.** One-line fix, assigned into T-3, and T-3 has merged. **Verify it actually landed** — an expired key currently resolves to a valid actor and PR-3's upstream filter is what stops it.

**30 URL-valued env keys can carry `user:pass@`** and are echoed verbatim by update-env. `maskSecretValues` is a name heuristic (8 words, 90/212 keys). Real fix is parse-URL masking. Folded into "CredentialStore D(c)", which is not a Phase 0 issue — so it is currently owned by nothing that exists.

**`FilterCache.invalidateScopes`** with a lone `document:<id>` key evicts nothing; the version stamp rebuilds next call. Perf loss, not correctness. Needs a test when the cache is wired (T-5).

### 3.3 Accepted, recorded

- env keys outside `protectedKeys` are dropped on `dumpENV` — pre-existing data loss, revisit at CredentialStore D(c)
- parent-dir symlink writes through by design; the guard covers the leaf
- `chat.read_others` + `access.diagnose` stay in `READ_ACTIONS` — re-decide when `content_moderator` splits (carry T-7)

### 3.4 Housekeeping

Stale worktree `.claude/worktrees/p0-4d` on `approof/p0-4d-env-hygiene` @ `b5146345` holds unrelated P0-7 work. Reap after confirming nothing is unmerged.

---

## 4. What #15 proves, and what it does not

The 12 scenarios cover onboarding → embedder → login → workspace → upload → cited answer → user creation → API key → audit log → member denial → restart survival → logout. That is the product working end to end against a real stack with a mock LLM.

It is **not** the authorization gate. Scenario 10 ("member cannot see admin UI or hit admin routes") is one negative case; the P0-5 matrix is every role × every action, and the vector-leak test is separate from both. Do not let a green E2E run stand in for §2.4.

At `7e6ed3bb` the spec file also fails `gate_urls` on two `http://mock-llm:8080/v1` literals (code-standards §7.4). Fix by hoisting the URL into a constant in `e2e/config.js`, not by adding the file to `.infi/checkignore` — the checkignore was emptied deliberately.

---

## 5. Gate procedure

1. Confirm every issue in §1 is closed and merged into `approof/main`.
2. Run §2.1–§2.6 on that exact SHA. Record the numbers, not "passed".
3. Confirm §3.1 is empty — every blocking hole has an issue and that issue is closed.
4. Run the full suite three times (§2.5). Three green runs with the same count, or the gate does not open.
5. Boot production against real Postgres and query the DB for the state each merged track claims (code-standards §7.2). A green suite is not a booted system; that distinction is why `pg_advisory_xact_lock` shipped broken through three passing checks.

Anything that cannot be re-run by someone who was not in the room does not belong in this checklist. If a criterion here turns out to need judgment, it is written wrong — fix the criterion.
