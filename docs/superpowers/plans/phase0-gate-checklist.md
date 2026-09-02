# Phase 0 gate checklist

What must be true before Track V fan-out opens month 2. Baseline for every number
below: `approof/main` @ `7587e74e`.

This file is the authority on these counts. `phase0-foundation.md` records earlier
figures taken before P0-3/P0-4 added route files, and counts invocations where this
file counts files or refs — read the numbers here, and the command beside each one.

A criterion belongs here only if a command decides it. "Reviewed and looks fine"
is not a gate — the whole point is that the gate can be re-run by someone who was
not in the room.

---

## 1. Issues that must be merged

| # | Track | What closing it proves | State at `cd6faf84` |
|---|---|---|---|
| #15 | E2E | ~~12 scenarios green headed against a real stack~~ | **PASS** — 12/12 × 3 at `e77d0b78`, 1 headed + 2 headless, each preceded by `up.sh up`. Independent witness (QA-1, not Dev3): `docs/superpowers/evidence/qa1-e2e-witness.md`. See §4 for what this does *not* prove |
| #26 | PR-4b | ~~Every route carries a named scope~~ | **closed** — counter 0 at `b66ebc5d` |
| #27 | PR-4c | ~~No key can be minted with `*`~~ | **closed** at `c74fa0ac` — all three sites gone, verified on a fresh database; see §2.1 |
| #25 | T-4a | ~~Role literals gone from internal routes~~ | **closed** at `70283c1b` — §2.2 passes |
| #29 | T-4b | ~~Jobs + embed + `/v1` wired to the engine~~ | **closed** at `800292ff` |
| #30 | T-5 | Vector queries filter by ACL — **the one that matters most** | not started |
| #28 | T-6 | Audit export + retention + redaction | part A **closed**; retention + redaction open |
| #42 | cleanup | ~~`PG_SCHEME` in test setup~~ | **closed** at `b46655e5` |
| #33 | P0-4D(c) | ~~CredentialStore, encrypted at rest~~ | **closed** — parts 1-3 |
| #38 | flake | ~~`modelPricing` etag~~ | **closed** at `0fce7589` — see §2.5 |
| #31 | T-7 | Admin duties separable | not started |

Merge order is fixed by file overlap, not by importance: ~~T-4a → T-4b → #39 → PR-4c~~ → **T-5 → T-7**. PR-4c went last on purpose — it removes `*` from keys, and every route had to already want a named scope before that was safe. What remains is T-5 and T-7, plus #32 (embed session token, on hold for the mint oracle) and #50 (delete simple-SSO, which waits on T-7).

T-6 is off the critical path and can land any time after T-4b.

---

## 2. Criteria a command decides

Run from the repo root on the merge candidate. Each row is pass/fail, no judgment.

### 2.1 API key scopes

**PASS — both halves, at `c74fa0ac`** (#27). The route half closed at `b66ebc5d` (#26); the key half closed here.

**Route half.** `apiKeyWildcardSweep.test.js` and its `EXPECTED_WILDCARD_ROUTES` counter are **deleted** — a counter that can only ever read 0 stopped being a gate once the wildcard could not be minted. `API_KEY_SCOPES.TEMPORARY_ALL` went with it. The standing command is now the grep that proves the concept is gone rather than counting instances of it:

```bash
git grep -n 'TEMPORARY_ALL' -- server        # 1 line: the comment in scopes.js saying it is gone
git grep -rn 'scopes.includes("\*")' -- server/utils/middleware
```
The second must return **nothing**. `validApiKey.js:117` now reads `context.scopes.includes(action)` with no short-circuit; the one surviving `includes("*")` is in `models/apiKeys.js:18`, which is `validateScopes` **refusing** it — the opposite construct, and it must stay.

**Key half.** Three things had to go together, and did:

| what | where |
|---|---|
| schema default `["*"]` on `api_keys.scopes` | dropped by migration `045000` |
| the model's fallback to the same value | `validateScopes` now throws on an absent, empty, or wildcard list (`models/apiKeys.js:15-24`) |
| the `includes("*")` short-circuit in the middleware | gone (`validApiKey.js:117`) |

Verified on a real fresh database rather than on report:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
DB="gate_$$"
psql "postgresql://approof:approof@localhost:5432/postgres" -c "CREATE DATABASE $DB;"
cd server && DATABASE_URL="postgresql://approof:approof@localhost:5432/$DB" \
  ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
psql "postgresql://approof:approof@localhost:5432/$DB" -tAc \
  "SELECT count(*) FROM api_keys WHERE scopes::jsonb @> '[\"*\"]'::jsonb;"
psql "postgresql://approof:approof@localhost:5432/$DB" -tAc \
  "SELECT column_default IS NULL FROM information_schema.columns
     WHERE table_name='api_keys' AND column_name='scopes';"
```
**Measured: `0` and `t`.** A raw `INSERT` omitting `scopes` fails with
`null value in column "scopes" ... violates not-null constraint` — the column is NOT NULL
with no default, so there is no path, supported or raw, that mints a key without a scope list.

A fresh database has no legacy rows, so the above exercises the new default but **never
the backfill**. That half was verified separately by restoring the old default, seeding
two legacy `["*"]` rows, and running `045000` against them:

- wildcard rows **2 → 0**
- `api_key_legacy_wildcard_grants` recorded **2** (so the boot report can name them)
- `system.env.read` present on **0** rows — the migration deliberately withholds it, because a legacy key was never granted provider credentials and inheriting them through a migration is not a grant anyone made
- replayed once more: still 0 and 2, nothing double-written

**Tests that carry this.** `server/__tests__/api/wildcardKeyDeniedHttp.test.js` — 3 `it` blocks, **5 cases**: `it.each` over three routes with three different required scopes (`/v1/auth`/`system.read`, `/v1/workspaces`/`workspace.read`, `/v1/admin/users`/`user.read`), so a pass cannot come from one route happening to be unguarded, plus two more. Its fixture inserts the `["*"]` row with **raw SQL on purpose** — `ApiKey.create` rejects it and the column has no default, so no supported path can produce the row the test needs. The two extra cases are what make it a real test: one asserts the row still stores `["*"]` verbatim (the refusal is the middleware's, not a silent rewrite), the other flips the same row to named scopes and gets 200 (positive control — without it, a middleware that refused everything would pass).

`server/__tests__/prisma/apiKeyWildcardMigration.test.js` covers the migration itself in four tests: none left after, every rewrite recorded, no default, and re-running changes nothing.

### 2.2 Role literals

```bash
# The exclusions are in the commands, not just the prose below — a command that
# does not encode its own exemptions gets run without them by whoever runs it next.
EXCL='server/utils/authorization/|server/utils/helpers/admin/index.js|server/utils/chats/commands/img.js'

# \bROLES\. not ROLES\. — the bare form also matches VALID_ROLES. in models/user.js,
# a role-name validator rather than a role check. Two false positives without it.
git grep -cE '\bROLES\.' -- 'server/**/*.js' | grep -vE "^($EXCL)" | awk -F: '{s+=$2} END {print s+0}'

# Match the CALL. The bare names survive in comments explaining what replaced them
# (deploymentMode.js:9, requirePermission.js:1-2); a gate that reads its own
# documentation as a violation gets bypassed rather than fixed.
git grep -cE 'flexUserRoleValid\('        -- 'server/**/*.js' | awk -F: '{s+=$2} END {print s+0}'
git grep -cE 'strictMultiUserRoleValid\(' -- 'server/**/*.js' | awk -F: '{s+=$2} END {print s+0}'
test ! -e server/utils/middleware/multiUserProtected.js && echo "multiUserProtected: deleted"
git grep -nE 'role (===|!==) "(admin|manager|default)"' -- 'server/**/*.js' \
  | grep -v __tests__ | grep -vE "^($EXCL)"
```

**All four must be 0** outside `server/utils/authorization/` and the two exemptions below.

### Exemptions (PMO ruling, 2026-09-02)

| File | Why it keeps a role reference | Closed by |
|---|---|---|
| `server/utils/helpers/admin/index.js` | Role *hierarchy* for user management — who may act on whom. That is a property of the role model itself, not a route guard, so it does not become an `assertAuthorized` call. | #31 (T-7) D-1/D-4 |
| `server/utils/chats/commands/img.js:55` | `user.role === "admin"` gating a chat command. Reached through the chat pipeline, which T-5 owns. | #30 (T-5) |

Both are exemptions from the **grep**, not from the rule: each must still end up
behind the engine or be deleted by the issue named. An exemption whose issue
closes without touching the file is a bug in this table, not a permanent waiver —
re-check the file when that issue closes.

At `70283c1b`, after T-4a merged, running the commands exactly as written:
**0 refs, 0 calls, 0 calls, 0 non-exempt literals**, and `multiUserProtected.js`
is deleted. **§2.2 passes.**

The one literal left is `utils/chats/commands/img.js:55`, which is exempt
(→ #30 T-5). `documentPurgeGuard.js:33`, which was *not* exempt, is gone.

### 2.2a Every org-wide grant outside `super_admin` is justified in the seed

An org-wide grant — `principal_role_grants.workspace_id IS NULL` — applies
everywhere, to every workspace, forever. `super_admin` is meant to hold those.
Nothing else should, without a sentence saying why.

```sql
SELECT r.name, r.scope, count(*) AS org_wide_grants
FROM principal_role_grants g JOIN roles r ON r.id = g.role_id
WHERE g.workspace_id IS NULL
GROUP BY r.name, r.scope ORDER BY 3 DESC;
```

**Any role but `super_admin` in that output needs a comment in the seed file
naming the reason.** No comment is a finding, not a style note.

This is not theoretical. T-1 granted every legacy `manager` and `default` user an
**org-wide `member` role** (`20260902020000_t1_authz_schema/migration.sql:405-410`),
and org-scope `member` holds `workspace.read`, `workspace.write`, and six
`document.*` actions (`:312-317`). The engine widens org-wide grants to every
resource — `engine.js:119-120` matches `workspace_id: null` OR the resource's
workspace — and it never reads `workspace_users`. So the moment T-4a removed the
`getWithUser` role bypass, **every user could reach every workspace**, through the
authorization system rather than around it.

What made it survive review: the migration also backfills `workspace_users.role_id`
correctly (step 6, `:425-443`, with a `policy_versions` guard and a careful
editor-not-viewer ruling). It looks like membership was handled. **Nothing reads
that column except `documentFilter.js:154`** — the engine's grant lookup does not,
so the per-workspace roles the migration so carefully assigned had no effect on
route authorization at all.

The lesson generalizes past this bug: **a backfilled column with no reader is not
a safeguard.** When a migration writes a column, the review question is "which
code path reads it, today", and a `git grep` answers it. That check would have
caught this at T-1 review.

Fixed in T-4a's `044000` migration: org `member` narrows, and workspace-scoped
grants derive from `workspace_users.role_id` — giving that column its reader.

### 2.3 Frontend capability gates

```bash
git grep -l '"admin"\|"manager"\|"default"' -- 'frontend/src/**/*.jsx' | wc -l
```

32 files at `7587e74e`. These are UI affordances, not a security boundary — but they all evaluate false once the legacy role column stops being written, so **a real admin stops seeing the admin UI**. This ships in the same release as T-4a or the product is broken for its own operators. It is a gate item because it is the failure that looks like a bug report, not like a security finding.

### 2.4 Vector ACL — the load-bearing one

`ENABLE_DOC_VECTORS_CANONICALIZE` must be set **and** every legacy-uuid call site migrated. The job refuses to run otherwise, by design:

```bash
grep -n "CanonicalizeNotEnabledError" server/jobs/docVectorsCanonicalize.js
git grep -n "DocumentVectors.where\|deleteForWorkspace\|removeDocuments" -- 'server/**/*.js' | grep -v __tests__ | wc -l
```

**Still 8 provider files at `c190bf8d`, after T-4b.** T-4b's W-12 added dual-id
handling but did not migrate any provider — nothing under `vectorDbProviders/`
changed, so this criterion is untouched by #29 and belongs entirely to #30.

Worth stating because "T-4b touched vector identity" reads like progress here and
is not: the guard in `docVectorsCanonicalize.js` still refuses to run, which is
correct, and the count that would let it run has not moved.

The unit is files, not matched lines — a provider is migrated or it is not, and
one file holds several call sites, so a line count moves for reasons that are not
progress:

```bash
git grep -l 'DocumentVectors\|deleteForWorkspace\|removeDocuments' \
  -- 'server/utils/vectorDbProviders/**' | wc -l
``` The guard comment in `docVectorsCanonicalize.js:14-20` states the failure precisely: after the job rewrites `document_vectors.docId` to canonical ids, any caller still looking up by legacy uuid **silently matches nothing**, so deleting a document leaves its vectors behind and they stay answerable. Silent, not loud.

**Gate: the enable flag is only set after the last of those 20 sites moves, and the vector-leak test passes with the flag on.** Setting the flag earlier turns a refusing job into a corrupting one.

The vector-leak test itself (P0-5 DoD item 8): two users, documents with disjoint ACLs, a question answerable only from the other user's document → must not be answerable. This is the single most important test in Phase 0. It gates on its own.

### 2.5 Suite stability

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export DATABASE_URL="postgresql://…"   # real Postgres, per code-standards §7.0
export API_KEY_PEPPER="…"              # ≥32 bytes
export STORAGE_DIR="…"                 # see §6 — four requirements, not two
cd server && yarn test
```

**Three consecutive full runs, same pass count, zero flakes.** Three, not one — the known flakes are intermittent, and a single green run does not distinguish "fixed" from "lucky".

**PASS at `190a5b88`: 85 suites / 940 tests, identical across three runs, 0 failures.**

Also verified in the same pass, per §2.2a:

```sql
SELECT r.name, count(*) FROM principal_role_grants g JOIN roles r ON r.id = g.role_id
WHERE g.workspace_id IS NULL GROUP BY r.name;
```
→ **`super_admin` only**, re-verified on a fresh migrated database at `c190bf8d`
(after T-4b). T-4a's `044000` narrowed org `member` as intended, and #29 did not
reintroduce an org-wide grant.

This is a snapshot, not a standing pass. Re-run it on the merge candidate — #30 and #31 still change the authorization path, and a suite that was stable before them says nothing about after.

Two flakes are recorded as fixed; both were re-checked here rather than taken on report:
- **DROP DATABASE race — fixed.** `engine.test.js:44`, `t1-authz-migration.test.js:99` and `documentFilter.test.js:43` each close `afterAll` with `}, 60_000);`.
- **`modelPricing` etag** (`[→ #38]`) — did not recur across the three runs. The register's original cause note was wrong: Dev1 traced it to a lazy getter plus a background refresh plus singleton-on-require, not a shared cacheDir. **Three clean runs do not close it** — an intermittent failure that did not happen is not a fixed one, which is exactly why it has an issue rather than a strike-through.

Without the pepper, six suites fail at import time and are counted as *failed*, not skipped — the `Tests:` line silently shrinks. A reviewer who forgets it reads a smaller green number as success. The pepper is one of **four** environment requirements; all four are in §6, and a red local run says nothing about the code until every one of them is set.

### 2.6 Repo standards

```bash
./scripts/check-local.sh
bash ~/.claude/plugins/cache/infi-skills/infi-skills/0.1.0/skills/infi-dev/scripts/task.sh \
  check --base approof/main --issue <the issue number this branch closes>
```

**Use a fresh database.** Since T-4b, single-user is decided by `users.count()`, so a leftover row from an earlier probe makes the R5 tests fail with an error that names the test rather than the row (code-standards §7.8).

**Generate the Prisma client first.** A gate run against a stale client reports
the wrong thing rather than an error (code-standards §7.6): the legacy-wildcard
boot report answers count 0, which reads as "clean".

```bash
cd server && ./node_modules/.bin/prisma generate --schema prisma/schema.prisma
```

Both must pass on the merge candidate. `check-local.sh` runs the §5.1 model-import gate, the §7.1a `db push` gate, and the §7.5 locals-contract gate; anything added later is picked up automatically.

`check-db-push.sh` reports a **pending count** for the five HTTP suites still on `db push` (code-standards §7.1a). Pending is not passing: the gate opens only when that count is 0 and the allowlist in the script is empty. Those five ran for weeks against an empty `permissions` table, so any authorization assertion they made proved nothing.

### 2.7 Node version pinned

```bash
git grep -A2 '"engines"' -- 'package.json' '*/package.json' | grep '"node"'
```

Every package that runs Node must pin `">=22 <23"`. At `7587e74e` all four are pinned, `frontend/` included (`3caffef6`) — one rule everywhere beat writing down an exemption.

**The pin is only half of it — every runtime that executes this code must agree.**
An `engines` field is a declaration; a base image and a CI runner are the actual
Node that runs. E2E caught a regression the pin itself could not: the container
was still on 18.

```bash
git grep -nE 'node_[0-9]+\.x|node:[0-9]+' -- docker/   # every pin must be 22
git grep -n 'node-version' -- .github/workflows        # must all be 22
```

The first grep is deliberately wider than `FROM.*node:`. That narrower form was
used once and **missed two lines**: the Dockerfile installs Node from nodesource
in both arch base stages (`docker/Dockerfile:25` and `:94`,
`deb.nodesource.com/node_18.x`), which is not a `FROM` line at all. A base image
tag and an apt repository are both "which Node runs", and a check that knows only
one shape finds only one.

Dockerfile is `node:22-slim` since `450b19b1`. **The workflows are not.** At
`c190bf8d`, five steps across three files still request Node 18:

| Workflow | Steps |
|---|---|
| `lint.yaml` | 3 |
| `check-package-versions.yaml` | 1 |
| `check-translations.yaml` | 1 |

Only `ci.yml` is on 22. `lint.yaml` runs `yarn install --frozen-lockfile` under
Node 18 against `"engines": {"node": ">=22 <23"}` — an install whose declared
requirement its own runtime does not meet.

All workflows are on 22 as of `main`, `run-tests.yaml` included — that one
matters most, since it is the one that actually loads `jsonwebtoken`.

**Nothing builds the image.** CI runs the suite on a runner, lint runs on
another; neither builds `docker/Dockerfile`. E2E is the only thing that has ever
caught an image regression, and it catches it late and by symptom. Both Node
drifts above were found after the fact for this reason.

`.github/workflows/docker-build.yaml` closes it: build on PR when anything the
image depends on changes, single-arch, no push, no registry credentials — the
question is only whether it still builds. It carries the pin grep as a step, so
the check lives beside the thing it checks rather than in this document.

The pin is not cosmetic. `jsonwebtoken@9.0.2` fails to load on Node 26 (SlowBuffer) at `utils/http/index.js:4`, so a CI image bump would break authentication and the cause would look unrelated to the change.

### 2.8 Residual risks have owners

Every line in `docs/superpowers/residual-risks.md` must carry an issue reference
`[→ #N]`, a `[closed …]` note, or be struck through. A line with none of those is
a risk nobody owns.

```bash
grep -nE '^[-0-9]' docs/superpowers/residual-risks.md \
  | grep -vE '\[→ #[0-9]+|\[→ backlog|\[→ needs issue|\[closed|\[reference|~~' | wc -l
```

**Must be 0.** Four markers count as owned:

| Marker | Means |
|---|---|
| `[→ #N …]` | An open issue owns it. Text after the number is allowed and encouraged — `[→ #25 T-4a, slot 044000]` says more than the bare number. |
| `[→ backlog …]` | Real, scheduled past Phase 0, no issue yet. Names the track. |
| `[closed: …]` | Fixed or accepted. **The marker states what closed it** — a SHA, a doc section, or "accepted by design". `[closed]` alone is not evidence. |
| `[reference, not a risk]` | The line is a note that landed in the register — a command to copy, a release note. Not everything filed here is a risk, and pretending otherwise inflates the count. |
| `[→ needs issue …]` | Real and unowned. **This is a finding at gate time**, not a pass — it counts as marked so the register is honest about what has no owner, rather than laundering it behind an issue number that does not exist. |

`~~struck~~` also passes, for a line kept as history.

At `dffad34f` the count was **30**: the register predates the convention. Cleared
in one pass rather than at gate time — a register read during an incident is
worth more than one reconstructed under time pressure.

The register moved out of `.infi/` (gitignored — a fresh worktree had no copy at
all, and a risk register that does not survive a clone is not a register) to
`docs/superpowers/`, tracked.

Lines that describe something since fixed must be struck, not left standing — a stale risk register costs the same review time as a live one and teaches readers to skim it. Stale lines were struck at `6a4307a8`; check again each time the gate runs.

---

## 3. Open holes

Read from `docs/superpowers/residual-risks.md`, verified against the tree at `6a4307a8`. Ordered by what happens if the gate opens without them.

### 3.1 Closed since this file was written

All three of the original blockers were resolved by `6a4307a8`. Verified, not taken on report:

**DROP DATABASE flake — fixed.** `}, 60_000);` closes the `afterAll` in all three suites (`engine.test.js:44`, `t1-authz-migration.test.js:99`, `documentFilter.test.js:43`). The `[flake, unowned]` line in `docs/superpowers/residual-risks.md` is stale and should be struck.

**`document_acl` org-wide kill switch — assigned.** The `"*"` sentinel becomes `orgWide:true` in #29 (T-4b), which lands before T-5 wires drivers. The ordering is the point: if T-5 went first the sentinel would be baked into every provider.

**Node 26 — pinned.** `engines.node` is `">=22 <23"` in all four package.json files, `frontend/` included since `3caffef6`.

Also confirmed: **`actorResolver` now checks `expiresAt`** — `actorResolver.js:39`, `const expired = ctx.expiresAt && new Date(ctx.expiresAt) <= new Date();`. An expired key no longer resolves to a valid actor on its own; it is not relying on PR-3's upstream filter any more.

**Nothing is blocking as of `7587e74e`.** This section stays because the gate re-runs: anything that lands here later must be empty again before the gate opens, and "it was empty last week" is not the check.

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

~~At `7e6ed3bb` the spec file also fails `gate_urls` on two `http://mock-llm:8080/v1` literals~~ — **fixed at `e77d0b78`** the recommended way: the URL is now built in `e2e/config.js` from `MOCK_LLM_HOST`, and the spec file has no `http://` literal left. Not by adding the file to `.infi/checkignore` — the checkignore was emptied deliberately.

---

## 5. Gate procedure

1. Confirm every issue in §1 is closed and merged into `approof/main`.
2. Run §2.1–§2.7 on that exact SHA. Record the numbers, not "passed".
3. Confirm §3.1 is still empty — re-verify each item in the tree rather than trusting this file, which records a state, not a guarantee.
4. Run the full suite three times (§2.5), with the §6 environment set first. Three green runs with the same count, or the gate does not open.
5. Boot production against real Postgres and query the DB for the state each merged track claims (code-standards §7.2). A green suite is not a booted system; that distinction is why `pg_advisory_xact_lock` shipped broken through three passing checks.

Anything that cannot be re-run by someone who was not in the room does not belong in this checklist. If a criterion here turns out to need judgment, it is written wrong — fix the criterion.

---

## 6. Local server test env — four things, or the numbers are meaningless

Every command in §2 that ends in `yarn test` needs all four of these. Missing any
one produces failing suites that read as regressions and are not: a local run at
`e77d0b78` showed **22 failed suites**; with all four set the same tree was
**98/98 suites, 1052/1052 tests**, identical to CI. Source: Dev3 ledger-15 addendum.

| # | Requirement | What breaks without it |
|---|---|---|
| 1 | **Node 22** — `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` | `engines: ">=22 <23"` rejects the machine default (node 26); `yarn` refuses to run at all |
| 2 | **`API_KEY_PEPPER` ≥ 32 bytes** | `assertApiKeyPepper()` runs at module load, so ~6 suites die at `require` time, before a test executes (code-standards §7.0) |
| 3 | **`STORAGE_DIR`** | `server/utils/files/index.js:10` resolves it outside development; undefined throws `paths[0] must be of type string` and takes out `routeWiring` |
| 4 | **A fresh, migrated, *dedicated* database** | Since T-4b, `isConfirmedSingleUser` counts real `users` rows on top of the mocked `isMultiUserMode`, so a leftover user row from an earlier probe fails a correct test — and the error names the test, not the row (**code-standards §7.8**) |

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export API_KEY_PEPPER="local-dev-api-key-pepper-32-bytes-min"
export STORAGE_DIR="$PWD/server/storage"
export DATABASE_URL="postgresql://approof:approof@localhost:5432/gate_$$"
psql "postgresql://approof:approof@localhost:5432/postgres" -c "CREATE DATABASE gate_$$;"
cd server && ./node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma
yarn test
```

Item 4 is the one that catches people twice: the database must be **fresh** (§7.8)
*and* built by `migrate deploy`, never `db push` (code-standards §7.1a) — `db push`
creates the tables but runs none of the 31 seed INSERTs, so the authorization suites
pass against an empty `permissions` table.

A red local run is not evidence about the code until all four are set. Do not report
one as a regression before checking this table.
