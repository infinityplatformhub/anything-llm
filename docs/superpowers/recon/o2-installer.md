# Recon — O2 Installer / setup wizard

Owner: Dev 5. Base `origin/approof/main` @ `fb848620`. Read-only recon; no code.

Backlog (program-backlog.md:66): *O2 | Installer/setup wizard | P0-2 | 3 cw | ติดตั้งเครื่องเปล่า → ใช้งานได้ ภายใน 1 ชม. โดยไม่แตะ .env มือ*

## 0. The headline

A blank machine cannot reach a running instance today, and the blocker is not the wizard — it is that **the server refuses to boot without a secret nobody generates**.

`API_KEY_PEPPER` throws at import time when it is shorter than 32 bytes (`server/utils/apiKeySecurity/index.js:9`). Nothing in `docker/docker-entrypoint.sh` creates it, and `docker/.env.example` mentions it nowhere. So the documented path — copy `.env.example`, `docker compose up` — produces a container that dies on startup until the operator hand-edits a file. That is the DoD failing at the first step, before any wizard is reached.

The wizard itself is the smaller half of this issue: `frontend/src/pages/OnboardingFlow/` already exists with Home, LLMPreference, UserSetup, DataHandling and Survey steps. O2 extends it; it does not build it.

## 1. What exists

| Piece | State |
|---|---|
| `docker/docker-compose.yml` | postgres:16 + app, `DATABASE_URL` composed from `POSTGRES_*`, healthcheck, named volume |
| `docker/docker-entrypoint.sh` | waits for PG → `prisma generate` → `migrate deploy` → boot. **Generates nothing.** |
| `docker/.env.example` | 604 lines |
| `server/.env.example` | 615 lines |
| `frontend/src/pages/OnboardingFlow/` | 5 steps, already shipped |
| `server/utils/boot/markOnboarded.js` | infers "onboarded" from `LLM_PROVIDER` / `VECTOR_DB` / `AUTH_TOKEN\|JWT_SECRET` |
| `writeEnvFileAtomic` (`updateENV.js:2095-2112`) | P0-4D(a): exclusive open at `0600`, `fsync`, `rename`; refuses symlinks and foreign-owned files |

## 2. The five secrets, and a wrinkle worth knowing before writing code

**updated (2026-09-02, after reading the consumers): this section was wrong about `AUTH_TOKEN`, and the correction is below the original text rather than replacing it, so the diff shows what changed.**

`INSTANCE_AUTH_KEYS` (`updateENV.js:1834-1840`) names five keys: `AUTH_TOKEN`, `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`. This section originally read that set as "exactly the set O2 must generate". That is true of four of them.

**`AUTH_TOKEN` must NOT be generated** (PMO ruling, 2026-09-02). It is not a machine secret: it is the single-user password the operator chooses, set through `POST /system/update-password` from the onboarding UserSetup step (`frontend/src/pages/OnboardingFlow/Steps/UserSetup/index.jsx:137`), and `docker/.env.example:405` says so outright — `AUTH_TOKEN="hunter2" # This is the password to your application`. Generating it breaks the install three ways: `validatedRequest` leaves its no-auth passthrough branch as soon as the variable is set (`utils/middleware/validatedRequest.js:29-36`); `POST /system/request-token` then compares the submitted password against 32 random bytes nobody has seen (`endpoints/system.js:400-405`), so no password can ever succeed; and the "just me, no password" path works precisely by leaving the variable empty (`endpoints/system.js:706`).

The set O2 generates is therefore **four**: `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`. `JWT_SECRET` belongs there — it is a signing key with no human meaning, read only by `utils/http/index.js:26-28,62`, and UserSetup rotates it anyway.

But `dumpENV`'s `protectedKeys` allowlist does not treat them alike — measured, not assumed:

| Key | In `protectedKeys`? |
|---|---|
| `SIG_KEY` | yes — `dumpENV` writes it |
| `SIG_SALT` | yes — `dumpENV` writes it |
| `AUTH_TOKEN` | **no** — and it is not generated at all; see the update above |
| `JWT_SECRET` | **no** |
| `API_KEY_PEPPER` | **no** |

So `dumpENV` cannot be the mechanism for the generated set: two of the four (`JWT_SECRET`, `API_KEY_PEPPER`) would be silently dropped. That is not a defect to fix here — `AUTH_TOKEN` and `JWT_SECRET` are excluded on purpose (they are `secret: true` in `KEY_MAPPING`, and #48 moved credential-valued settings into the encrypted store rather than back onto disk). It means **generation must write the file directly through `writeEnvFileAtomic`, not through `dumpENV`**, and the plan must say so or it will produce an installer that appears to work and persists two keys out of five.

PMO ruling Q2 sends these to the mounted `.env` rather than CredentialStore, and the reason holds up in the code: `SIG_KEY`/`SIG_SALT` are the store's own encryption inputs (`updateENV.js:1830-1831` says so outright), so a store that needs them cannot also hold them.

**Only when absent.** An operator who set a value must never have it replaced — a regenerated `API_KEY_PEPPER` invalidates every existing API key, and a regenerated `SIG_KEY` makes the credential store unreadable.

## 3. Locale — the risk is narrower than it looked

V9 (#61) found that `pg_trgm` produces zero trigrams for Thai on a `LC_CTYPE=C` database, so Thai chat search silently loses its index. The obvious conclusion was that O2 must force the locale. Measured instead:

```
postgres:16         template1 | en_US.utf8
postgres:16-alpine  template1 | en_US.utf8
```

Both images set `LANG=en_US.utf8`, so `initdb` already produces a UTF-8 cluster. **The compose happy path is not affected.** `POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8"` is still worth adding (PMO ruling Q4) as one line of belt-and-braces against a future base-image change — but as insurance, not as the fix.

The real exposure is the operator who points `DATABASE_URL` at an existing corporate PostgreSQL, which may well be `C`. That is a **verify** problem, not a **set** problem: the collation of a database is fixed at creation and O2 cannot change it. #61 already logs the finding at every boot (`utils/chatSearch/localeSupport.js`); O2's job is to surface it during setup, while the operator is still choosing a database.

Per ruling Q4: warn loudly, never block. English search is unaffected, and refusing to boot would lock out every customer who does not use Thai.

## 4. Scope

**In (ruling Q1):** docker compose is the happy path that must fit in an hour. External PostgreSQL gets a preflight that reports what fails and how to fix it, with no time guarantee. Bare metal is out.

1. **Secret generation** — the five keys above, `crypto.randomBytes`, written through `writeEnvFileAtomic`, only when absent, with a printed notice that these five must be backed up (ruling Q3; rotation and backup are O3).
2. **Preflight / doctor** — PostgreSQL reachable; `datctype` UTF-8; `CREATE EXTENSION` permitted for `vector` and `pg_trgm`; port free; storage writable. Reported as a list an operator can act on, not a stack trace.
3. **Wizard** — new steps on the existing `OnboardingFlow`: deployment/database mode, secrets (generated, shown once), preflight results.
4. **`.env.required.example`** — roughly fifteen keys that actually matter, alongside the existing 604-line file rather than replacing it.

**Out:** offline/air-gap bundles (O1); rotation and backup (O3); bare-metal install. Ruling Q5 constrains rather than adds: setup must make **no network calls**, so an air-gapped install is not blocked by O2 even though O2 does not package for it.

## 5. Open questions for the plan

- Where does generation run? The entrypoint (before Node boots, so `API_KEY_PEPPER` exists by import time) or a `prestart` script? The pepper throws at *import*, so anything running inside the server process is already too late.
- Does the preflight run as a container command an operator can invoke on demand (`docker compose run --rm app doctor`), or only during boot? A doctor that only runs at boot cannot be used to diagnose a failed boot.
- ~~`markOnboarded` infers onboarding from `AUTH_TOKEN`/`JWT_SECRET`.~~ Settled below; the shape is narrower than it first looked — see the ruling and the note under it.

## 6. Mockup

Required (infi-dev step 1.5 — this has UI). Two directions, both clickable, both showing the preflight page in four states (idle / checking / pass / fail-with-remedy):

- **A — full-page wizard**: one decision per screen, back/next, progress rail.
- **B — single-page checklist**: every requirement listed at once, each row resolving in place.

Committed to `docs/superpowers/mockups/` and pinned by SHA in the evidence contract before `task.sh start`.

## PMO rulings (2026-09-02)

Ruling: (Q1) compose = happy path <1 hr; external PG = preflight/doctor reporting failures with remedies, no time guarantee; bare-metal out of O2.

Ruling: (Q2) generated secrets go to the mounted `.env`, never CredentialStore — chicken-and-egg, since `SIG_KEY` is the store's own key. Atomic, `0600`, and only when the key is absent; never overwrite an operator's value.

Ruling: (Q3) rotation and backup are O3. O2 prints a clear notice at generation naming the five keys that must be backed up, plus a residual entry.

Ruling: (Q4) warn hard, never block, matching #61's boot report. Compose adds `POSTGRES_INITDB_ARGS="--locale=en_US.UTF-8"` as belt-and-braces.

Ruling: (Q5) O2 must not *obstruct* air-gap — no network calls during setup — but offline bundling stays in O1.

Ruling: `.env.example` is not replaced; a new `.env.required.example` (~15 keys) sits beside it.

Ruling: mockup is two directions (full-page wizard vs single-page checklist), preflight page clickable in four states, committed under `docs/superpowers/mockups/` and SHA-pinned before `task.sh start`.


Ruling: (1) secret generation runs in `docker-entrypoint.sh` **before node**, as a standalone script (`server/scripts/ensure-secrets.js`) that must not import `apiKeySecurity` — the pepper throws at import, so anything inside the server process is already too late. It calls `writeEnvFileAtomic` directly rather than `dumpENV`, because `dumpENV`'s allowlist carries only `SIG_KEY` and `SIG_SALT` of the five (measured, §2), and writes a key only when that key is absent.
If wrong: an installer that looks like it worked and persisted two secrets out of five, with the failure appearing later as "every API key is invalid after restart".

Ruling: (2) the preflight is a subcommand an operator can run on demand (`docker compose run --rm app doctor`) AND runs automatically in the entrypoint before boot, exiting non-zero with the checklist when it fails. A doctor that only runs at boot cannot diagnose a boot that fails.
If wrong: the operator's only diagnostic is the crash they are trying to explain.

Ruling: (3) the "onboarded" signal is separated from the presence of secrets: `markOnboarded` must read the explicit flag, not infer from `AUTH_TOKEN`/`JWT_SECRET`. A legacy deployment holding secrets but no flag gets the flag set once by a backfill so the wizard does not appear on an instance that has been in use for months. Three tests: fresh install with auto-generated secrets → wizard appears; legacy install with secrets and no flag → wizard does not appear; flag already true → wizard does not appear.
If wrong: O2 ships a wizard that no fresh install ever reaches — the auto-generated `AUTH_TOKEN` marks every new instance as already onboarded.

**Note on ruling (3), measured after it was issued.** The flag and the reader already exist: `SystemSettings.markOnboardingComplete()` writes `onboarding_complete` (`systemSettings.js:806`), it is in `protectedFields` (`:40`), and `markOnboarded()` already checks `isOnboardingComplete()` first and returns early. The legacy backfill is also already there, with the log line and the one-shot semantics the ruling asks for.

What actually needs changing is one branch: `isLegacyOnboarded()` (`markOnboarded.js:45`) treating `AUTH_TOKEN || JWT_SECRET` as proof of prior use. With generation moved into the entrypoint, that variable is always set by the time Node boots, so **every** fresh install takes the legacy path, gets the flag written, and never sees the wizard. The other three signals in that function (`LLM_PROVIDER`, `VECTOR_DB`, multi-user mode) are genuine evidence of prior use and stay.

Removing that branch has a cost worth stating rather than discovering: a legacy instance whose ONLY signal is `AUTH_TOKEN`/`JWT_SECRET` — no LLM provider, no vector DB, single-user — would start seeing the wizard. That is a real population (a single-user instance configured entirely through the UI), so the backfill must run **before** the branch is removed, in the same release, not after.

---

# Part 2 — doctor CLI and the handoff to OnboardingFlow

Written after rulings (1)–(3), against the tree at `approof/main`. Everything below is measured,
not designed from memory; where the ruling's wording and the code disagree, the code is quoted.

## 7. The doctor subcommand

### 7.1 The invocation in the ruling does not exist yet, for two reasons

Ruling (2) names `docker compose run --rm app doctor`. Two corrections, both mechanical:

- **There is no service called `app`.** `docker/docker-compose.yml` defines `postgres` and
  `anything-llm` (container_name `approofworkspace`). The command is
  `docker compose run --rm anything-llm doctor`.
- **The entrypoint ignores arguments.** `docker/Dockerfile:182` is
  `ENTRYPOINT ["/bin/bash", "/usr/local/bin/docker-entrypoint.sh"]`, and the script never reads
  `$1` or `"$@"`. Today `… run --rm anything-llm doctor` starts the whole server and drops the
  word `doctor` on the floor — it does not fail, which is worse, because the operator gets a
  booting app and concludes the doctor passed.

So the subcommand is not "expose an existing check"; it is a dispatch the entrypoint does not
have. The shape:

```bash
# docker-entrypoint.sh
case "${1:-serve}" in
  doctor)  exec node /app/server/scripts/doctor.js ;;
  serve|"") ;;                       # fall through to the existing block
  *) echo "unknown command: $1" >&2; exit 64 ;;
esac
```

`exec` matters: without it the doctor's exit code is the script's only if it is the last command,
and the existing file ends with `wait -n; exit $?`.

### 7.2 Two callers, one module, different failure semantics

Ruling (2) requires the checks to run **both** on demand and automatically before boot. That is
one check module with two callers, and they must not behave identically:

| caller | when | on blocking failure | on warning |
|---|---|---|---|
| `scripts/doctor.js` | operator runs it | print checklist, `exit 1` | print, `exit 0` |
| entrypoint, before `migrate deploy` | every boot | print checklist, `exit 1` (never boots) | print, continue |

The automatic run must sit **after** the existing `until node -e '…pg connect…'` loop and
**before** `prisma migrate deploy`. Before the wait loop it would fail on a database that is
merely still starting — compose's `depends_on: service_healthy` covers the happy path but not an
external `DATABASE_URL`. After `migrate deploy` is too late: the "can this role create
extensions" check exists precisely because migrations are what fail without it, and #61's own
`CREATE EXTENSION pg_trgm` is one of them (§7.13 exists because that failure leaves the database
in a failed-migration state that blocks every later migration — a doctor that runs after the
migration is a post-mortem, not a preflight).

### 7.3 The checks, and which of them can block

Blocking = the boot genuinely cannot succeed. Everything else warns. The list is short on
purpose; a doctor that reports twenty things trains the operator to skim it.

| check | how | blocking? |
|---|---|---|
| PostgreSQL reachable | `pg.Client.connect()` on `DATABASE_URL` | yes |
| server version ≥ 16 | `SHOW server_version_num` | yes — `pg_input_is_valid` (used by #61's migration, `20260902100000`) landed in PostgreSQL 16, and the migration is not conditional, so 15 fails at `migrate deploy` with a syntax-level error that names nothing about versions |
| `CREATE EXTENSION` permitted | `SELECT rolsuper OR pg_has_role(current_user,'pg_create_extension','member')` is not reliable across versions; the honest probe is `CREATE EXTENSION IF NOT EXISTS <x>` inside a transaction that is **rolled back** | yes, for `vector` and `pg_trgm` |
| extension available in the image | `SELECT 1 FROM pg_available_extensions WHERE name=$1` | yes — distinguishes "no permission" from "not installed on this server", which have completely different remedies |
| `LC_CTYPE` produces Thai trigrams | `SELECT datctype FROM pg_database WHERE datname=current_database()` + `array_length(public.show_trgm('ประวัติ'),1)` | **no** — ruling Q4. Reuses `server/utils/chatSearch/localeSupport.js` from #61 rather than restating the probe |
| the five secrets present | `process.env` after the generation step | yes |
| `STORAGE_DIR` writable | `fs.accessSync(dir, W_OK)` — not a write-then-delete, which races a second container | yes |
| port free | skipped in-container; the port is published by compose, and a bound port fails at `docker compose up` with a clearer message than anything we can print | not a check |

The `pg_available_extensions` row is the one worth defending: without it, an operator on a
managed PostgreSQL that simply does not ship `vector` is told to ask for permissions they can
never be granted.

**The transaction-rollback probe is the only honest permission check**, and it has a cost worth
stating: on a database where the extension is *absent and creatable*, the probe creates it and
rolls it back, which is a real DDL write inside a transaction. On PostgreSQL that is safe
(extension DDL is transactional), but the doctor is then no longer strictly read-only, and the
recon should not pretend otherwise.

### 7.4 Ruling Q5 (no network calls) constrains the doctor specifically

Every check above talks to `DATABASE_URL` and the local filesystem, nothing else. The temptation
to add "can we reach the LLM provider" must be refused: it would make the doctor fail on an
air-gapped install that is otherwise perfectly healthy, and provider reachability belongs to the
OnboardingFlow step where the operator is choosing a provider anyway.

### 7.5 The doctor must not import the server

`scripts/doctor.js` imports `pg`, `fs`, and `utils/chatSearch/localeSupport.js`. It must **not**
reach `server/index.js`, `utils/boot/`, or anything that pulls `apiKeySecurity` — the pepper
throws at import (the same trap ruling (1) names for `ensure-secrets.js`), and a doctor that
crashes on a missing pepper cannot diagnose a missing pepper. This is a `--findRelatedTests`-able
invariant: one test that requires `scripts/doctor.js` with `API_KEY_PEPPER` unset and asserts it
loads.

## 8. Handoff to OnboardingFlow (ruling 3)

### 8.1 The split the mockups imply but do not show

Both mockups render the preflight as a page in a browser. The doctor runs in the entrypoint,
**before Node boots**. Those cannot be the same surface: if a blocking check fails, there is no
server to serve the page. Stating the division plainly, because it decides what gets built:

- **Blocking failures → terminal only.** Extension permission, unreachable database, unwritable
  storage. The operator sees the checklist in `docker compose logs`, fixes it, restarts.
- **Warnings and choices → browser.** `LC_CTYPE`, the five generated secrets and their backup
  notice, and the admin account. These are the rows that survive into a React step, and they are
  exactly the rows mockup B ended up marking "เตือน", "สร้างให้อัตโนมัติ", and "คุณกรอกเอง"
  after the QA-3 pass.

The QA-3 fix that moved the admin account out of the auto-checked list is therefore not
cosmetic — it is this boundary showing up in the design.

### 8.2 What already exists, measured

- `SystemSettings.markOnboardingComplete()` — `models/systemSettings.js:806`, writes
  `onboarding_complete`, in `protectedFields` at `:40`.
- `GET /onboarding` — `endpoints/system.js:132`, **unauthenticated**, returns
  `{onboardingComplete}`. Correct: the frontend must ask before anyone can log in.
- `POST /onboarding` — `:147`, `requirePermission("settings.write", orgResource)` (#52).
- `useRedirectToHomeOnOnboardingComplete()` — `frontend/src/hooks/useOnboardingComplete.js`,
  redirects to home when the flag is true, and **only** on `false` stays. Note it treats any
  non-`false` value as complete, so a failed fetch redirects away from onboarding.
- Steps registry — `frontend/src/pages/OnboardingFlow/Steps/index.jsx`: `home`,
  `llm-preference`, `user-setup`, `data-handling`, `survey`.
- `markOnboarded()` — `utils/boot/markOnboarded.js`, already early-returns on the flag, already
  logs the one-shot legacy message.

### 8.3 The one-line change, and why it is the whole of ruling (3)

`isLegacyOnboarded()` (`markOnboarded.js:44`):

```js
  // Check if the AUTH_TOKEN/JWT_SECRET is set, so we can assume onboarding is complete …
  if (!!process.env.AUTH_TOKEN || !!process.env.JWT_SECRET) return true;
```

Ruling (1) moves secret generation into the entrypoint, so by the time this line runs on a
**fresh** install both variables are set. Every new instance takes the legacy path, gets the flag
written, and never sees the wizard. The other three signals (`LLM_PROVIDER`, `VECTOR_DB`,
multi-user mode) are genuine evidence of prior use and stay.

Ordering is the part that cannot be got wrong, and it is a sequence, not a preference:

1. Ship the release containing the backfill (`markOnboarded` as it stands today) and let it run
   at least once on every deployment that is going to upgrade.
2. Only then remove the `AUTH_TOKEN || JWT_SECRET` branch.

Both steps land in the same release **in that order within a single boot** — `markOnboarded()`
runs at boot before any frontend request can ask `/onboarding`, so a legacy instance upgrading
straight to the O2 release still gets its flag written by the old logic on that first boot,
provided the branch removal does not also apply to that first run. Concretely: the backfill and
the removal cannot both be a naive edit of the same function. The safe shape is a migration that
writes `onboarding_complete` for instances matching the *old* predicate, run as a migration (once,
ordered, recorded) rather than as boot-time inference — after which `isLegacyOnboarded()` loses
the branch and never needs to reason about it again.

The population this protects is real and easy to under-weight: a single-user instance configured
entirely through the UI, with no `LLM_PROVIDER` in its `.env` because it was set through settings,
would otherwise be shown a setup wizard for a system that has been in production for a year.

### 8.4 The three tests ruling (3) requires, with the shape that makes them fail correctly

Per §7.9 each must be red for the right reason, which here means asserting the flag's *source*,
not just its value:

1. **fresh install** — no `onboarding_complete` row, no `LLM_PROVIDER`/`VECTOR_DB`, single-user,
   `AUTH_TOKEN` set (as the entrypoint now guarantees) → `markOnboarded()` returns `false` and
   writes nothing. This is the test that fails today, and it is the reason the branch is being
   removed.
2. **legacy install** — same, but the migration has already written the flag →
   `isOnboardingComplete()` is true and `markOnboarded()` early-returns without a second write.
   Assert the early return (no `_updateSettings` call), not merely the true flag, or the test
   passes for a fresh install too.
3. **flag already true** — `markOnboarded()` returns before touching `isLegacyOnboarded()`.

A fourth is worth adding and is not in the ruling: **the migration's own predicate**. Seed a row
that looks like the protected population (secrets present, nothing else) and assert the migration
sets the flag; seed a genuinely fresh row and assert it does not. Without it, "the backfill ran
first" is an ordering claim with nothing verifying what it backfilled.

## 9. Two things found while reading, that the plan must not discover late

**`writeEnvFileAtomic` returns `false`; it does not throw.** `utils/helpers/updateENV.js:2056`
refuses two cases — the path is a symlink, and the file's uid is not the process uid — by logging
and returning `false`. `ensure-secrets.js` must branch on the return value. A generation step that
ignores it prints "secrets generated" and boots a server whose `API_KEY_PEPPER` exists only in
that process's memory, so every API key minted in that run stops verifying on the next restart —
exactly the failure ruling (1)'s "if wrong" clause describes, arriving through a different door.

**The uid check and the bind mount are on a collision course.** Compose mounts
`./.env:/app/server/.env` from the host and runs the container as `${UID:-1000}:${GID:-1000}`.
When the host file is owned by a different uid than the container user — the ordinary case on
macOS, and on Linux whenever `UID` is unset and the host user is not 1000 — `writeEnvFileAtomic`
refuses, correctly, and generation cannot write. This must be a **doctor check with a named
remedy** (`chown` the file, or set `UID`/`GID` in `docker/.env`), not something the operator meets
as a refusal message during first boot. It is also the reason the doctor's secrets check reports
"cannot write `.env`" separately from "secret missing": they have different fixes.

## PMO rulings on part 2 (2026-09-02)

Ruling: (2a) the doctor invocation is `docker compose run --rm anything-llm doctor` — the service in `docker/docker-compose.yml` is `anything-llm`, there is no `app`. The entrypoint gains `case "${1:-serve}"` with `exec` for the doctor arm.
If wrong: the documented command boots the whole server and drops the word `doctor` silently, so the operator reads a booting app as a passing check.

Ruling: (2b) the doctor also runs automatically in the entrypoint, after the PostgreSQL wait loop and before `prisma migrate deploy`.
If wrong: before the wait loop it fails on a database that is merely still starting; after `migrate deploy` it is a post-mortem of the failure it exists to prevent (§7.13).

Ruling: (2c) the doctor is not read-only — the only honest permission probe is `CREATE EXTENSION` inside a rolled-back transaction — and its output says so rather than claiming otherwise.
If wrong: an operator who was told "read-only" finds extension DDL in their audit log and stops trusting every other line the tool prints.

Ruling: (2d) extension **availability** (`pg_available_extensions`) is reported separately from extension **permission**.
If wrong: an operator on a managed PostgreSQL that does not ship `vector` is told to request a grant that cannot exist.

Ruling: (2e) the PostgreSQL version floor is 16, checked and reported by name.
If wrong: PostgreSQL 15 fails inside migration `20260902100000` at `pg_input_is_valid` with an error that never mentions a version.

Ruling: (2f) `scripts/doctor.js` must not import the server, `utils/boot/`, or anything reaching `apiKeySecurity`, with one test asserting it loads with `API_KEY_PEPPER` unset.
If wrong: the doctor throws at import on exactly the missing-pepper case it is meant to diagnose.

Ruling: (3a) blocking failures are reported in the terminal only; warnings and operator choices (LC_CTYPE, the five secrets, the admin account) are the React step.
If wrong: the design promises a preflight page that cannot exist, because a blocking failure means no server booted to serve it.

Ruling: (3b) a migration writes `onboarding_complete` for instances matching the old predicate, and only then does `isLegacyOnboarded()` lose its `AUTH_TOKEN || JWT_SECRET` branch. A test asserts the migration's predicate on both populations.
If wrong: either every fresh install is marked onboarded and never sees the wizard, or a single-user instance in production for a year is shown a setup wizard.

Ruling: (4a) `ensure-secrets.js` branches on `writeEnvFileAtomic`'s return value and fails the boot when it is `false`.
If wrong: the installer prints "secrets generated" and boots with a pepper that exists only in memory, so every API key minted that run stops verifying at the next restart.

Ruling: (4b) a `.env` owned by a uid other than the container user is a **blocking** doctor check, reported separately from "secret missing", with the remedy named (`chown`, or `UID`/`GID` in `docker/.env`).
If wrong: the ordinary macOS bind-mount case surfaces as a refusal message during first boot instead of a checked precondition with a fix.

Ruling: (5) O2 generates four secrets — `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`. `AUTH_TOKEN` is never generated; it stays absent so the operator sets it as their password during onboarding. One test asserts `ensure-secrets` leaves `AUTH_TOKEN` unwritten even when it is absent.
If wrong: the installer boots, prints "secrets generated", and hands the operator an instance nobody can ever log into, with no reset path short of editing the `.env` the installer just wrote.

Ruling: (6) the onboarding backfill is a boot-time one-shot guarded by a settings row, not a SQL migration — the old predicate reads three environment variables that SQL cannot see. Belongs to O2b.
If wrong: a migration is written against a predicate the schema cannot evaluate, and it silently backfills on the one signal it can read.

Ruling: (7) O2 splits into **O2a** (doctor CLI, ENTRYPOINT dispatch, ensure-secrets — no UI, starts immediately) and **O2b** (React warn step, onboarding backfill, moving `AUTH_TOKEN` out of the mockups' secret list — waits on the user's A/B answer).
If wrong: work with no UI in it sits blocked behind a mockup decision it does not depend on.
