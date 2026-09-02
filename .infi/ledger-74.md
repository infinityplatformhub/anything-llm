# Ledger — #74 (O2a: doctor CLI, ENTRYPOINT dispatch, ensure-secrets)

Ruling: `AUTH_TOKEN` is not generated. It is the operator's single-user password (`docker/.env.example:405`, set from `OnboardingFlow/Steps/UserSetup/index.jsx:137`), not a machine secret. The generated set is four: `JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`.
ถ้าผิด: `validatedRequest` leaves its no-auth branch (`:29-36`), `/system/request-token` compares the operator's password against 32 bytes nobody has seen (`system.js:400-405`), and the owner is locked out permanently with no reset short of editing the file the installer just wrote.

Ruling: `ensure-secrets.js` decides "already set" from the **file**, not from `process.env`. The entrypoint may carry a value that is never persisted, and treating that as set would leave the key missing after the next restart.
ถ้าผิด: a key that exists for exactly one container lifetime, which is the failure this task exists to prevent.

Ruling: `ensure-secrets.js` branches on `writeEnvFileAtomic`'s return value and exits non-zero. That function **returns false**, it does not throw (`updateENV.js:2073,2081`).
ถ้าผิด: prints "generated", boots with a pepper that lives only in that process, and every API key minted in the run stops verifying at the next restart.

Ruling: the backup notice prints only on a run that generated something.
ถ้าผิด: a notice on every boot is a notice nobody reads, which is the same as not having one.

Ruling: `db.locale` is the only non-blocking check, and its level is a property of the check rather than of how badly it failed.
ถ้าผิด: an install that works perfectly in English refuses to boot over a Thai search index.

Ruling: `db.locale` reports **ok** when `pg_trgm` is not installed yet, saying so, instead of reporting a locale failure. On a fresh install the migration is what installs the extension, so the probe cannot run at all. Measured: a fresh `LC_CTYPE=C` database returns `function public.show_trgm does not exist`, which is not evidence about the locale.
ถ้าผิด: every first install is told its LC_CTYPE is broken and sent to recreate a database that is fine.

Ruling: `ext.available` and `ext.permitted` are two checks. The first reads `pg_available_extensions`.
ถ้าผิด: an operator on a managed PostgreSQL that does not ship `vector` is told to request a grant that cannot exist.

Ruling: the permission probe uses `CREATE EXTENSION` **without** `IF NOT EXISTS`, and only for extensions that are genuinely absent; extensions already present are reported as installed. (QA-3 ruling 6.)
ถ้าผิด: `IF NOT EXISTS` on an installed extension is a no-op that returns success, so the doctor reports a privilege the role may not have. Verified by mutation — swapping it back leaves the suite green, which is why the "installed vs permitted" wording is asserted rather than the call.

Ruling: the doctor is not read-only, and its output says so — the probe writes inside a transaction it rolls back.
ถ้าผิด: an operator who was told "read-only" finds extension DDL in their audit log and stops trusting every other line.

Ruling: a database that cannot be reached makes `db.version`, `ext.available`, `ext.permitted` and `db.locale` report **failed**, never ok.
ถ้าผิด: a doctor that passes its database checks by never running them.

Ruling: `MIN_SERVER_VERSION_NUM` is pinned as a number in a test, not merely described in a remedy string. (Mutation found this: lowering the floor to 13 left the suite green, because the remedy prose still read plausibly.)
ถ้าผิด: the floor drifts to a version where `pg_input_is_valid` does not exist and migration `20260902100000` fails with an error that never mentions a version.

Ruling: `env.writable` checks the **directory** first, with `W_OK|X_OK`. (QA-3 ruling 2.)
ถ้าผิด: `writeEnvFileAtomic` renames a temp file into that directory, and it skips its own guards entirely on ENOENT — so a read-only directory is invisible to it and surfaces as a rename failure mid-boot rather than as a refusal.

Ruling: `env.writable` names **both** uids in the failure and gives `UID=$(id -u) GID=$(id -g) docker compose up` as the remedy. (QA-3 ruling 3.)
ถ้าผิด: `${UID:-1000}` in compose resolves to 1000 on every machine, because `UID` is a shell variable the shell does not export — so on macOS (uid 501) the mounted `.env` belongs to someone the container is not, and the default install dies with "permission denied" and no way to work out whose permission.

Ruling: `secrets.present` is reported separately from `env.writable`, and accepts a value from `process.env` as well as from the file.
ถ้าผิด: two different problems ("cannot write the file" vs "no value anywhere") collapse into one row and send the operator to the wrong fix; and a value supplied through compose's `environment:` block is reported missing when the server will in fact see it.

Ruling: `secrets.present` does not require `AUTH_TOKEN`.
ถ้าผิด: the doctor blocks the boot of every correctly-installed instance, since AUTH_TOKEN absent is the correct state of a fresh install and of every "just me, no password" one.

Ruling: `storage.writable` uses `accessSync`, not write-then-delete.
ถ้าผิด: a probe file races a second container starting at the same moment, and a failed cleanup leaves litter in the operator's data directory.

Ruling: the ENTRYPOINT `case` is the first executable statement, before the STORAGE_DIR banner. (QA-3 ruling 5.)
ถ้าผิด: a doctor run leads with 14 lines of warning about a container that is not going to serve anything, ahead of the answer the operator asked for.

Ruling: the doctor arm uses `exec`.
ถ้าผิด: the script continues to `wait -n; exit $?` and the doctor's verdict is discarded — the gate reports success because the last command succeeded. Mutation-verified: removing `exec` turns three tests red.

Ruling: an unrecognised command exits 64 rather than falling through to `serve`.
ถ้าผิด: the original defect, one letter at a time — `dcotor` boots the server and teaches the operator their command worked.

Ruling: in the serve path the order is ensure-secrets → doctor → `migrate deploy`, `&&`-chained.
ถ้าผิด: secrets after the doctor fails `secrets.present` on every fresh install; the doctor after `migrate deploy` is a post-mortem of the failure it exists to prevent, because a failed `CREATE EXTENSION` leaves the database in a failed-migration state that blocks every later migration (§7.13).

Ruling: `APP_ROOT` (default `/app`) replaces the hardcoded paths, so the script can be run against a stub tree by a test.
ถ้าผิด: the only shell file in the boot path stays untestable, and "the dispatch works" remains a claim rather than a check — the entrypoint tests run the real file under `bash` with stub binaries and assert on exit codes, because grepping for a `case` statement goes green on a dispatch that does not work.

Ruling: `POSTGRES_INITDB_ARGS: "--locale=en_US.UTF-8"` is added to compose and labelled as insurance, not as the fix. `postgres:16` already sets `LANG=en_US.utf8` (recon §3, measured), so the bundled path is not affected today.
ถ้าผิด: a later reader takes it for the repair and stops checking the locale of external databases, which is where the real exposure is.

Ruling: `HOW_TO_USE_DOCKER.md` documents the doctor with `--no-deps`. (QA-3 ruling 4.)
ถ้าผิด: `depends_on: postgres condition: service_healthy` makes the command wait on the bundled database's healthcheck, so an operator diagnosing an unreachable external database watches a healthcheck for a database they are not using.

Ruling: (TL-2 M11) `ensure-secrets` prints key NAMES, never values, and three tests hold it there — the generated values, any 64-hex run at all, and an operator's existing value quoted back.
ถ้าผิด: container logs are shipped, aggregated and retained by people who are not the operator, so a printed pepper is printed forever. The code already behaved this way; without the tests that was a coincidence rather than a constraint.

Ruling: (TL-2 OBS-1) the new assignments are APPENDED. `writeEnvFileAtomic` takes the whole file body, so a generator that parses into pairs and re-serialises silently rewrites the operator's `.env`. Tested with a file carrying comments, indentation, blank lines, trailing spaces, a `#` inside a quoted value, and no trailing newline.
ถ้าผิด: comments and ordering vanish and any value whose quoting the parser does not reproduce is corrupted — on a file the operator may have hand-written.

Ruling: (TL-2 OBS-2) the write is wrapped in try/catch as well as checked for `false`. `writeEnvFileAtomic` fails in two shapes: its own guards log and return false, but a directory that rejects the temp-file open or the rename throws straight out of `fs` (`updateENV.js:2101,2110`) — the likelier of the two on a read-only mount.
ถ้าผิด: the read-only-volume case escapes as a stack trace, which tells the operator where our code is rather than what to do about their volume. Verified: removing the try/catch turns the assertion red with `at Object.<anonymous>` in the output.

Ruling: (TL-2 OBS-4) the `doctor` arm skips the STORAGE_DIR banner deliberately — the doctor's own `storage.writable` check names the real path and a remedy.
ถ้าผิด: 14 lines of banner about a container that is not going to serve anything, ahead of the answer the operator ran the command for.

Ruling: (TL-2 OBS-5) text assertions on the shell file for `exec`, for `&&` between the three stages, and for the preflight sitting inside the backgrounded block after `cd`. Weak guards, kept because the behavioural tests cannot see a `;` that silently becomes an unconditional migrate.
ถ้าผิด: `&&` degraded to `;` runs the migration whatever the doctor said, which is the exact failure the ordering exists to prevent.

Ruling: (TL-2 note) generating `JWT_SECRET` alone does not close the no-auth passthrough. That branch is a disjunction, `!AUTH_TOKEN || !JWT_SECRET` (`validatedRequest.js:29-36`), so with AUTH_TOKEN still absent a fresh install stays open until the operator picks a password — which is what the onboarding flow expects. Recorded in the script's header comment beside `clearStoredCredential`'s own statement that AUTH_TOKEN is instance authentication (`updateENV.js:1886`).
ถ้าผิด: a future reader "fixes" the asymmetry by generating AUTH_TOKEN too, and reintroduces the lockout.

Ruling: (TL-2) `vector` is required only when `VECTOR_DB=pgvector`; `pg_trgm` is required always. The default vector store is lancedb (`utils/helpers/index.js:88`), which never touches PostgreSQL, and no migration creates the `vector` extension — whereas migration `20260902100000` creates gin_trgm_ops indexes on every install.
ถ้าผิด: stock `postgres:16` — the image in `docker-compose.yml:9` and in `.github/workflows/ci.yml:16` — does not ship pgvector, so the doctor would block the boot of every default install and turn this project's own CI red. Found by TL-2 on a machine without pgvector; my own gate passed at `3165b913a` only because my database happened to have it.

Ruling: when `vector` is not checked, `ext.available` says so and names the setting that would make it checked.
ถ้าผิด: an operator who intends to use pgvector reads a green preflight that silently skipped their one real requirement.

Ruling: `requiredExtensions` compares case-insensitively and treats an unset `VECTOR_DB` as not-pgvector.
ถ้าผิด: `VECTOR_DB=PGVector` skips the check the operator needs, and an install that has not chosen a vector store yet is asked for an extension it will never use.

## Residual

- **QA-3 ruling 1, the half that is not testable here.** `POST /system/update-password` with `usePassword:false` blanks `AUTH_TOKEN` and `JWT_SECRET` in memory only (`endpoints/system.js:705-707`) — no `updateENV` call, nothing written. Three tests cover what O2a controls: a restart finds no `AUTH_TOKEN`, `JWT_SECRET` is not rotated, and ensure-secrets never writes `AUTH_TOKEN` back. The in-memory/on-disk divergence itself is pre-existing behaviour outside this issue's diff; flagged for O2b, where the React step meets it.
- **The doctor cannot be fully exercised on a dev box.** `ext.available`'s failing branch needs a server missing an extension it actually has, so it is driven through the exported `checkExtensions` with a made-up extension name rather than through `runChecks`. The `ext.permitted` probe likewise only reaches its writing branch on a server that ships an extension not yet installed; the test asserts the property that holds either way — whenever something WAS probed, the detail says it was rolled back — rather than pinning one server's shape.
- **`providerDocIdCallSites` and `samlRoutesHttp` fail under parallel jest, pass with `--runInBand`.** Both pass alone and on a stashed tree. `server/package.json:18` already runs the suite with `--runInBand`, so the gate is unaffected; noted because `--findRelatedTests` without it looks like two broken suites.
