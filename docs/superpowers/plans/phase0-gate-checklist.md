# Phase 0 gate checklist

What must be true before Track V fan-out opens month 2. Baseline for every number
below: `approof/main` @ `6a4307a8`.

This file is the authority on these counts. `phase0-foundation.md` records earlier
figures taken before P0-3/P0-4 added route files, and counts invocations where this
file counts files or refs — read the numbers here, and the command beside each one.

A criterion belongs here only if a command decides it. "Reviewed and looks fine"
is not a gate — the whole point is that the gate can be re-run by someone who was
not in the room.

---

## 1. Issues that must be merged

| # | Track | What closing it proves | State at `54db4028` |
|---|---|---|---|
| #15 | E2E | 12 scenarios green headed against a real stack | 14 `test()` blocks on `7e6ed3bb`; see §4 |
| #26 | PR-4b(4) | Last 11 wildcard routes carry named scopes | counter at 11 (was 52) |
| #27 | PR-4c | No key can be minted with `*` | not started |
| #25 | T-4a | Role literals gone from internal routes | GREEN in progress |
| #29 | T-4b | Jobs + embed + `/v1` wired to the engine | not started |
| #30 | T-5 | Vector queries filter by ACL — **the one that matters most** | not started |
| #28 | T-6 | Audit export + retention + redaction | not started |
| #31 | T-7 | Admin duties separable | not started |

Merge order is fixed by file overlap, not by importance: **4b-4 → T-4a → T-4b → T-5 → T-7 → PR-4c**. PR-4c is last on purpose — it removes `*` from keys, and every route must already want a named scope before that is safe (see `.infi/recon/pr4c.md`).

T-6 is off the critical path and can land any time after T-4b.

---

## 2. Criteria a command decides

Run from the repo root on the merge candidate. Each row is pass/fail, no judgment.

### 2.1 API key scopes

```bash
grep "EXPECTED_WILDCARD_ROUTES =" server/__tests__/utils/middleware/apiKeyWildcardSweep.test.js
```
**Must read 0**, and the sweep test must still pass — the counter and the code are checked against each other by the test itself. At `6a4307a8` it reads 11.

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

**All four must be 0** outside `server/utils/authorization/`. At `6a4307a8`: 185 refs, 27 files, 2 files, 2 sites.

The fourth grep is not redundant. `utils/chats/commands/img.js:55` and `utils/helpers/documentPurgeGuard.js:33` compare `user.role` to a string literal and never import `ROLES`, so the first grep cannot see them. Both are named in the P0-5 DoD and both are still present.

### 2.3 Frontend capability gates

```bash
git grep -l '"admin"\|"manager"\|"default"' -- 'frontend/src/**/*.jsx' | wc -l
```

32 files at `6a4307a8`. These are UI affordances, not a security boundary — but they all evaluate false once the legacy role column stops being written, so **a real admin stops seeing the admin UI**. This ships in the same release as T-4a or the product is broken for its own operators. It is a gate item because it is the failure that looks like a bug report, not like a security finding.

### 2.4 Vector ACL — the load-bearing one

`ENABLE_DOC_VECTORS_CANONICALIZE` must be set **and** every legacy-uuid call site migrated. The job refuses to run otherwise, by design:

```bash
grep -n "CanonicalizeNotEnabledError" server/jobs/docVectorsCanonicalize.js
git grep -n "DocumentVectors.where\|deleteForWorkspace\|removeDocuments" -- 'server/**/*.js' | grep -v __tests__ | wc -l
```

20 call sites across 8 providers at `6a4307a8`. The guard comment in `docVectorsCanonicalize.js:14-20` states the failure precisely: after the job rewrites `document_vectors.docId` to canonical ids, any caller still looking up by legacy uuid **silently matches nothing**, so deleting a document leaves its vectors behind and they stay answerable. Silent, not loud.

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

One remains:
- `modelPricing/index.test.js` etag `""` vs `"abc123"` — shared temp cacheDir across suites. Isolate the cacheDir per test when it recurs.

The DROP DATABASE race is **fixed on main**: `engine.test.js:44`, `t1-authz-migration.test.js:99` and `documentFilter.test.js:43` all close their `afterAll` with `}, 60_000);`. Verified at `6a4307a8`. The `.infi/residual-risks.md` line calling it unowned is stale.

Without both env vars, six suites fail at import time and are counted as *failed*, not skipped — the `Tests:` line silently shrinks. A reviewer who forgets them reads a smaller green number as success.

### 2.6 Repo standards

```bash
./scripts/check-local.sh
bash <path-to>/task.sh check --base approof/main --issue <n>
```

Both must pass on the merge candidate. `check-local.sh` currently runs the §5.1 model-import gate; anything added later is picked up automatically.

### 2.7 Node version pinned

```bash
git grep -A2 '"engines"' -- '**/package.json' | grep '"node"'
```

Every package that runs Node must pin `">=22 <23"`. At `6a4307a8`: root, `server/`, and `collector/` are pinned; **`frontend/package.json` has no `engines` block at all** — it builds through vite rather than running under Node in production, but an unpinned workspace is what lets a toolchain drift to 26 unnoticed. Add the block or record why it is exempt.

The pin is not cosmetic. `jsonwebtoken@9.0.2` fails to load on Node 26 (SlowBuffer) at `utils/http/index.js:4`, so a CI image bump would break authentication and the cause would look unrelated to the change.

### 2.8 Residual risks have owners

Every line in `.infi/residual-risks.md` must carry either an issue number or an explicit "accepted, revisit at X" ruling. See §3.

Lines that describe something since fixed must be struck, not left standing — a stale risk register costs the same review time as a live one and teaches readers to skim it. Three lines are stale as of `6a4307a8` (§3.1).

---

## 3. Open holes

Read from `.infi/residual-risks.md`, verified against the tree at `6a4307a8`. Ordered by what happens if the gate opens without them.

### 3.1 Closed since this file was written

All three of the original blockers were resolved at `6a4307a8`. Verified, not taken on report:

**DROP DATABASE flake — fixed.** `}, 60_000);` closes the `afterAll` in all three suites (`engine.test.js:44`, `t1-authz-migration.test.js:99`, `documentFilter.test.js:43`). The `[flake, unowned]` line in `.infi/residual-risks.md` is stale and should be struck.

**`document_acl` org-wide kill switch — assigned.** The `"*"` sentinel becomes `orgWide:true` in #29 (T-4b), which lands before T-5 wires drivers. The ordering is the point: if T-5 went first the sentinel would be baked into every provider.

**Node 26 — pinned.** `engines.node` is `">=22 <23"` in root, `server/`, and `collector/`. `frontend/` has no `engines` block (§2.7).

Also confirmed: **`actorResolver` now checks `expiresAt`** — `actorResolver.js:39`, `const expired = ctx.expiresAt && new Date(ctx.expiresAt) <= new Date();`. An expired key no longer resolves to a valid actor on its own; it is not relying on PR-3's upstream filter any more.

**Nothing is blocking today.** This section stays because the gate re-runs: anything that lands here later must be empty again before the gate opens, and "it was empty last week" is not the check.

### 3.2 Should have an issue before fan-out

**`authorizeMany` batch cap.** 0.176ms/resource, linear, no cap. Recon §W-6 caps at 500 inside T-4a; the `/v1` side is recorded in #29 (T-4b). Both halves must land — a cap on internal routes alone leaves the public surface uncapped, which is the half an attacker can reach.

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
2. Run §2.1–§2.7 on that exact SHA. Record the numbers, not "passed".
3. Confirm §3.1 is still empty — re-verify each item in the tree rather than trusting this file, which records a state, not a guarantee.
4. Run the full suite three times (§2.5). Three green runs with the same count, or the gate does not open.
5. Boot production against real Postgres and query the DB for the state each merged track claims (code-standards §7.2). A green suite is not a booted system; that distinction is why `pg_advisory_xact_lock` shipped broken through three passing checks.

Anything that cannot be re-run by someone who was not in the room does not belong in this checklist. If a criterion here turns out to need judgment, it is written wrong — fix the criterion.
