# Plan — O2 installer: doctor CLI, secret generation, onboarding handoff

Base: `approof/main` after `598c2e88` (recon part 2 merged). Recon:
`docs/superpowers/recon/o2-installer.md`. Mockups `24951395`
(`docs/superpowers/mockups/o2-installer-{a-wizard,b-checklist}.html`) — **awaiting the user's
A/B answer; `task.sh start` does not run until it arrives.**

Rulings this plan implements: Q1–Q5 and (1)–(3) from the recon's first ruling block, (2a)–(4b)
from the part-2 block.

---

## Finding before Task 1 — `AUTH_TOKEN` must not be generated, and the ruling that says it should is wrong

Ruling (1) and recon §2 both take `INSTANCE_AUTH_KEYS` (`updateENV.js:1834`) as "the five secrets
O2 generates". Reading the consumers rather than the set name, that is right for four of them and
**wrong for `AUTH_TOKEN`**, in a way that bricks every fresh install:

- `AUTH_TOKEN` is not a machine secret. It is **the single-user password the operator chooses**,
  set through `POST /system/update-password` from the onboarding UserSetup step
  (`frontend/src/pages/OnboardingFlow/Steps/UserSetup/index.jsx:137`), and documented as such in
  `docker/.env.example:405` (`AUTH_TOKEN="hunter2" # This is the password to your application`).
- `validatedRequest` takes its no-auth passthrough branch **only while `AUTH_TOKEN` is unset**
  (`utils/middleware/validatedRequest.js:29-36`). Setting it to random hex on a single-user
  instance flips every request to the token branch.
- `POST /system/request-token` then compares the submitted password against
  `process.env.AUTH_TOKEN` (`endpoints/system.js:400-405`). The value is 32 random bytes nobody
  has ever seen, so **no password can ever succeed** and there is no reset path short of editing
  `.env` by hand — which is the file the installer just wrote.
- It also destroys the "just me, no password" path outright: that flow works by leaving
  `AUTH_TOKEN` empty (`endpoints/system.js:706` sets it to `""` when `usePassword` is false).

`JWT_SECRET` is different and **is** generated: it is a signing key with no human meaning, read
only by `utils/http/index.js:26-28,62`, and the same UserSetup call rotates it anyway.

**So the generated set is four, not five:** `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`.
`AUTH_TOKEN` stays absent and is set by the operator in onboarding.

This is a ruling amendment, not a plan decision — recorded here and sent to PMO before Task 1
starts. It also changes the mockups: both list five keys under "ความลับของระบบ". The row for
`AUTH_TOKEN` moves to the admin-account block that QA-3 already split out, which is where a
password belongs.

Cost of getting this wrong, stated plainly because it is the whole reason for the finding: the
installer boots, prints "secrets generated", and hands the operator an instance they can never
log into.

---

## Task 1 — `scripts/ensure-secrets.js` (server, no route change)

RED first: `server/__tests__/scripts/ensureSecrets.test.js`.

Generates the four keys above with `crypto.randomBytes(32).toString("hex")`, **only when the key
is absent from the parsed `.env` body**, and writes through `writeEnvFileAtomic`
(`utils/helpers/updateENV.js:2056`) — not `dumpENV`, whose `protectedKeys` allowlist carries only
`SIG_KEY` and `SIG_SALT` of the set (recon §2, measured).

Constraints that are each a test:

1. **Must not import the server.** No `require` reaching `apiKeySecurity` — `index.js:7-9` throws
   at import when `API_KEY_PEPPER` is under 32 bytes, and this script exists to create it. Test:
   `require` the script with `API_KEY_PEPPER` unset and assert it loads. (Ruling 2f's twin.)
2. **Branches on the return value.** `writeEnvFileAtomic` returns `false` — it does not throw —
   when the path is a symlink or the file's uid is not the process uid. On `false` the script
   prints the reason and **exits non-zero so the boot fails** (ruling 4a). Test: point it at a
   symlink, assert exit ≠ 0 and that nothing was written through the link.
3. **Never overwrites.** Test: seed a `.env` with all four set to known values, run, assert the
   file is byte-identical. A regenerated `API_KEY_PEPPER` invalidates every API key; a regenerated
   `SIG_KEY` makes the credential store unreadable.
4. **Idempotent across runs.** Run twice, assert the second run writes nothing and the values match.
5. **Prints the backup notice** naming the four keys (ruling Q3), once, on the run that generated
   anything — not on every boot, which trains the operator to ignore it.

`API_KEY_PEPPER` needs ≥32 **bytes** and the check is on the string (`apiKeySecurity/index.js:9`);
64 hex chars satisfies it. Assert the generated length in the test rather than trusting the
arithmetic.

## Task 2 — `scripts/doctor.js` + the check module

RED first: `server/__tests__/scripts/doctor.test.js`.

One module of checks, two callers with different failure semantics (recon §7.2). Each check
returns `{id, level: "block"|"warn", ok, detail, remedy}` — the remedy is a field, not prose
appended at print time, so the same string reaches the terminal and (later) the React step.

Checks, per ruling (2c)–(2e) and recon §7.3:

| id | blocking | note |
|---|---|---|
| `db.reachable` | yes | `pg.Client.connect()` on `DATABASE_URL` |
| `db.version` | yes | `SHOW server_version_num` ≥ 160000 — migration `20260902100000` uses `pg_input_is_valid` unconditionally |
| `ext.available` | yes | `pg_available_extensions` for `vector`, `pg_trgm` — reported **separately** from permission (ruling 2d) |
| `ext.permitted` | yes | `CREATE EXTENSION IF NOT EXISTS` inside a transaction that is **rolled back** |
| `env.writable` | yes | `.env` uid matches the process uid and is not a symlink — the same two conditions `writeEnvFileAtomic` refuses on, checked here so the operator meets them as a preflight with a remedy rather than as a refusal mid-boot (ruling 4b) |
| `secrets.present` | yes | the four keys, reported **separately** from `env.writable` — different fixes |
| `storage.writable` | yes | `fs.accessSync(STORAGE_DIR, W_OK)`, not write-then-delete, which races a second container |
| `db.locale` | **no** | reuses `utils/chatSearch/localeSupport.js` `thaiTrigramSupport()` from #61 — do not restate the probe (ruling Q4) |

Output says outright that the extension probe writes and rolls back (ruling 2c). Tests:

1. every check declares a `remedy` when it can fail — a failure with no remedy is a check that
   makes the operator's problem legible without making it fixable
2. `db.locale` is `warn` and a failing `db.locale` alone yields exit 0
3. any `block` failure yields exit 1 and the checklist names it
4. the module loads with `API_KEY_PEPPER` unset (ruling 2f)
5. `ext.available` false and `ext.permitted` false report as two lines, not one — the managed-
   PostgreSQL case where `vector` is simply not shipped must not read as "ask for a grant"
6. no check opens a socket to anything but `DATABASE_URL` (ruling Q5) — scan the module for
   `http`/`https`/`fetch` rather than asserting behaviour

## Task 3 — ENTRYPOINT dispatch

`docker/docker-entrypoint.sh` gains, at the top:

```bash
case "${1:-serve}" in
  doctor) exec node /app/server/scripts/doctor.js ;;
  serve|"") ;;
  *) echo "unknown command: $1" >&2; exit 64 ;;
esac
```

`exec` is required: the file ends with `wait -n; exit $?`, so without it the doctor's exit code is
discarded (recon §7.1).

In the `serve` path, **after** the existing `until node -e '…pg connect…'` loop and **before**
`npx prisma migrate deploy` (ruling 2b):

```bash
node /app/server/scripts/ensure-secrets.js &&
node /app/server/scripts/doctor.js &&
```

Order matters and is not arbitrary: `ensure-secrets` first, so `secrets.present` can pass on a
fresh install; doctor second, so a blocking failure stops the boot before migrations run. §7.13
exists because a failed `CREATE EXTENSION` leaves the database in a failed-migration state that
blocks every later migration — a doctor that runs after `migrate deploy` is a post-mortem.

Ruling Q4's belt-and-braces goes in `docker/docker-compose.yml`:
`POSTGRES_INITDB_ARGS: "--locale=en_US.UTF-8"` on the `postgres` service. Both images already set
`LANG=en_US.utf8` so the happy path is unaffected today (recon §3); this is insurance against a
base-image change, and it must be labelled as such in the diff so a later reader does not take it
for the fix.

**Shell, not JS, so `--findRelatedTests` cannot reach it.** The evidence is a documented manual
run recorded in the ledger: `docker compose run --rm anything-llm doctor` on a database missing
extension permission → exit 1 with the checklist; the same with permission → exit 0.

## Task 4 — onboarding migration + branch removal

Migration slot **100000** is Dev5's; #61 used `20260902100000`. This one takes the next free
timestamp in the same slot.

The migration writes `onboarding_complete` into `system_settings` for rows matching the **old**
predicate. That predicate cannot be evaluated in SQL — `LLM_PROVIDER`, `VECTOR_DB` and
`AUTH_TOKEN` are environment, not table columns — so this is the one place the plan must diverge
from the ruling's literal wording and say why:

`isLegacyOnboarded()` reads four signals, three environment and one table
(`SystemSettings.isMultiUserMode()`). A migration sees only the table. So the backfill runs as a
**boot-time one-shot that is ordered before the branch removal takes effect**, not as SQL:
`markOnboarded()` keeps today's predicate for exactly one run, guarded by a new
`onboarding_backfill_done` setting, and the `AUTH_TOKEN || JWT_SECRET` branch is read only while
that guard is unset. The migration's job is to create the guard row as `false` for existing
installs and `true` for fresh ones — the latter distinguished by `system_settings` being empty of
every other signal at migration time.

If that distinction cannot be made cleanly, the fallback is the conservative one: leave the branch
in place and gate it on `process.env.AUTH_TOKEN` being *operator-set* rather than *present*, which
Task 1 makes possible because O2 no longer generates it. **Ask PMO before choosing** — this is
authorization-adjacent state and the ruling assumed a migration that the schema cannot support.

Tests (ruling 3b plus the fourth from recon §8.4):

1. fresh install, no `LLM_PROVIDER`/`VECTOR_DB`, single-user, secrets generated →
   `markOnboarded()` returns `false` and writes nothing
2. legacy install, flag already backfilled → early return, assert **no `_updateSettings` call**,
   not merely a true flag (or the test passes for a fresh install too)
3. flag already true → returns before reaching `isLegacyOnboarded()`
4. the backfill's own predicate: a row shaped like the protected population gets the flag; a
   genuinely fresh row does not

Task 1's finding makes test 1 pass for a better reason than the ruling anticipated: with
`AUTH_TOKEN` no longer generated, a fresh install has only `JWT_SECRET` set, so the branch is
half-defused before it is removed. That is not a substitute for removing it — `JWT_SECRET` alone
still trips it.

## Task 5 — React warn step

Only after Task 2, because the step renders the doctor's `warn` findings and nothing else
(ruling 3a): blocking failures never reach a browser, because a blocking failure means no server
booted to serve it.

New step in `frontend/src/pages/OnboardingFlow/Steps/index.jsx`, before `llm-preference`. Content
is the three rows the mockups mark as warn-or-choice: `db.locale`, the generated-secrets backup
notice, and the admin account — the last of which is where `AUTH_TOKEN` now lives, per the finding.

The step needs the doctor's findings after boot. `GET /onboarding` (`endpoints/system.js:132`) is
already unauthenticated, correctly, because the frontend must ask before anyone can log in; the
findings endpoint has the same requirement and **must not** leak anything an unauthenticated
caller should not have. `datctype` and "four secrets exist" are safe; connection strings, uids,
and paths are not. One test asserts the response body contains no value from `DATABASE_URL`.

`useRedirectToHomeOnOnboardingComplete` treats any non-`false` answer as complete, so a failed
fetch redirects away from onboarding. Leave that as it is — changing it is out of scope and would
alter behaviour for every existing step.

Mockup A or B decides the layout of this step only. Neither choice changes Tasks 1–4.

## Order

1 → 2 → 3, then 4 and 5 in parallel. Task 3 is the only one that cannot be verified by jest.
Task 4 is blocked on a PMO answer about the migration shape.

## Evidence

`task.sh check --issue <n>`. Contract runs the new test files by name first, then the related
set via `npx jest --findRelatedTests` (§7.14 — the full suite runs once on the merge target, by
PMO's gate, not here). A green suite alone proves nothing was broken, not that the new tests
exist; naming the files makes a missing file exit non-zero before the suite runs.

Worktree per §7.6c: `scripts/wt-bootstrap.sh approofworkspace_dev5`.

## Models

Implementer Sonnet, reviewer Sonnet. Final whole-branch review Opus + `security-review` — Task 1
writes instance secrets and Task 4 touches onboarding state that gates the whole app.
