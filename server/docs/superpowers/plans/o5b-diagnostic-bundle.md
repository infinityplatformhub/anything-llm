# Plan — O5b: `doctor --bundle` (issue #94)

Recon: `docs/superpowers/recon/o5b-diagnostic-bundle.md` (merged `b62a86940`, amended `70b781052`).
CLI only. No migration, no permission row, no slot reservation — ruling 1.

## Task 1 — `server/utils/diagnostics/index.js`

The assembly module. Nothing here writes a file or touches stdout; it returns a plain object, so
the redaction test can call it directly instead of through a process.

- `ENV_ALLOWLIST` — a frozen array. Every entry is there because someone decided it is diagnostic,
  and the review question for each is "why does the operator's problem need this".
- `collectEnv(env)` — allowlist first, then `stripUrlCredentials` for `DATABASE_URL`, then
  `scrubValue` over every surviving value. Keys absent from the environment are omitted rather
  than reported as empty: `""` and "not set" are different facts and the bundle should not blur
  them.
- `collectDatabase(client)` — migration rows (name, `applied_steps_count`, `finished_at`,
  `rolled_back_at`) and counts by table. Every query is individually tolerant: a bundle from a
  broken install is exactly when this runs, so one missing table must degrade one row, not the
  file.
- `buildBundle({...})` — versions, `runChecks()` output, the two above, resources. The whole
  result then goes through `scrubValue` once more before it is returned. Belt and braces, same
  reason `redaction.js` runs both guards.

## Task 2 — `--bundle` on the CLI

`scripts/doctor.js` grows a flag. JSON to **stdout only**; the human checklist and any assembly
diagnostics to **stderr** (ruling 2). `docker/docker-entrypoint.sh`'s `doctor)` arm forwards its
remaining arguments so `doctor --bundle` reaches the script at all.

## Task 3 — tests

`__tests__/utils/diagnostics/bundle.test.js`
- **the one that matters**: seed a known secret into every reachable source, serialise the whole
  bundle, assert each seeded value appears nowhere in the string. Whole-string scan, not
  per-field — a field added later without redaction fails this test rather than needing a new one.
- allowlist is frozen; no allowlisted key is `secret: true` in `KEY_MAPPING`
- `DATABASE_URL` keeps host and database, loses the password
- `event_logs` contributes counts only; no `metadata` value reaches the bundle
- a failing collector degrades its own section, not the bundle

`__tests__/scripts/doctorBundleCli.test.js`
- **the whole of stdout** parses as JSON (not: contains JSON)
- the checklist is on stderr
- plain `doctor` is unchanged
- the entrypoint's `doctor)` arm forwards arguments

## Task 4 — the `doctor.test.js` header note (PMO)

State what the suite needs of its database and that a stock `postgres:16` skips the pgvector
blocks rather than failing. TL-2 lost ten minutes to its absence.

## Out

`diagnostics.export` and its migration (O5b-ui), the UI download, shipping the bundle anywhere,
`event_logs` row content, counter wiring (O5a-wire).
