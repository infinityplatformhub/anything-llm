# Techlead-2 pre-review — #74 (O2a) plan `docs/superpowers/plans/o2-installer.md` @ `c7ef9d28`

Design review of Tasks 1–3 before Dev5 writes code. Nothing is implemented yet; every claim
below was checked against the code on `approof/main` at `c7ef9d28`.

The plan is strong, and its central finding — that `AUTH_TOKEN` must not be generated — is
correct on every point I could verify. Five observations and an eleven-entry mutation list
follow; none of them contradicts the plan, and two name a gap it does not cover.

---

## The `AUTH_TOKEN` finding — confirmed, with one addition the plan does not use

I read all three consumers the plan cites.

`validatedRequest.js:29-36` takes the passthrough branch on an **OR**:

```js
process.env.NODE_ENV === "development" ||
!process.env.AUTH_TOKEN ||
!process.env.JWT_SECRET
```

`request-token` (`endpoints/system.js:400-405`) compares the submitted password against
`process.env.AUTH_TOKEN` directly. Both match the plan's description, and the conclusion
holds: a generated `AUTH_TOKEN` is a password nobody has ever seen, with no reset path
short of editing the file the installer just wrote.

**One consequence the plan does not draw, worth stating in the code:** because the branch is
an OR, generating `JWT_SECRET` alone leaves `!AUTH_TOKEN` true, so passthrough still works on
a fresh install. That is the safe outcome, but it means the generated `JWT_SECRET` has no
effect at all until the operator sets a password. Not a defect — a reason the four-key set is
safe, and the kind of thing a reader of `ensure-secrets` will want to know.

**Additional evidence for the same ruling, from code that already exists:**
`clearStoredCredential` (`updateENV.js:1886-1889`) refuses every member of
`INSTANCE_AUTH_KEYS` with the message *"…is instance authentication, not a provider
credential; use /system/update-password."* The codebase already treats `AUTH_TOKEN` as
operator-chosen and names the route that sets it. Ruling (1) read the set's name; this reads
what the set is used for, and they disagree.

**`protectedKeys` verified.** The plan's reason for using `writeEnvFileAtomic` rather than
`dumpENV` is that `protectedKeys` carries only two of the five. I scanned the whole block
(`updateENV.js:1929-2012`): `SIG_KEY` and `SIG_SALT` are present; `JWT_SECRET`,
`API_KEY_PEPPER` and `AUTH_TOKEN` are not. A `dumpENV` after generation would drop three of
the four keys it had just created.

---

## OBS-1 — `writeEnvFileAtomic` takes a whole file body, and the byte-identical test does not cover the write

`writeEnvFileAtomic(envPath, contents)` replaces the file wholesale. So `ensure-secrets` has
to read the existing `.env`, add its lines, and hand back the entire body — which means it
owns the round trip through whatever parser and serializer it uses.

The plan's test 3 (*"seed a `.env` with all four set, run, assert byte-identical"*) exercises
only the path where **nothing is written**. The risky case is the other one: one key missing,
so the file is rewritten, and every unrelated line goes through the serializer. Comments,
blank lines, quoting styles and values containing `#` are all at risk, and losing a comment
in a file the operator maintains by hand is a real cost even when no value changes.

Add a test with a `.env` that contains a comment, a blank line, a quoted value and a value
containing `#`, missing exactly one of the four keys: after the run every pre-existing line
must be unchanged and the new key appended.

## OBS-2 — `env.writable` checks two conditions; `writeEnvFileAtomic` has three ways to refuse

The two the plan names — symlink, and uid mismatch — are the two that `return false`
(`updateENV.js:2072-2085`). There is a third path that **throws**: `openSync(tempPath, "wx",
0o600)` on line 2100 fails when the *directory* is not writable, and that error is re-thrown
after cleanup rather than converted to `false`.

A read-only bind mount (`:ro`) or a directory owned by another account produces exactly that.
`.env` itself can be perfectly owned and not a symlink, so `env.writable` passes, and then
`ensure-secrets` dies with a raw stack trace instead of the remedy the plan is careful to
give everywhere else.

`env.writable` should also check the containing directory, and `ensure-secrets` should wrap
the call so a throw becomes the same message as a `false`. The plan's rule — branch on the
return value — is right and incomplete.

## OBS-3 — `db.locale` will warn on every fresh install, for a reason that is not locale

`thaiTrigramSupport()` (`chatSearch/localeSupport.js:34-55`) runs
`array_length(public.show_trgm($1), 1)`. `show_trgm` exists only once `pg_trgm` is installed,
and on a fresh database the doctor runs **before** `migrate deploy`. The query throws, the
catch returns `{supported: null, error}`, and the check reports a problem.

`warn` is the right level, and reusing the probe rather than restating it is the right call
(ruling Q4). But the first thing a new operator sees would be a warning caused by the ordering
the plan itself chose. Distinguish "cannot answer yet — `pg_trgm` is not installed, this is
expected before the first migration" from "answered, and the locale is wrong". Same class as
the 42P01 finding on #30 slice 1b: a diagnostic that cries wolf on a healthy fresh install
teaches operators to skip the line that matters later.

`supported: null` is already a distinct value from `false`, so the information is there — it
just needs to reach the operator as two different messages.

## OBS-4 — the `exec` dispatch changes what `doctor` sees, and the `serve` insert must stay inside the subshell

`docker-entrypoint.sh` today opens with a `STORAGE_DIR` warning block (lines 3-16), then a
`{ cd /app/server/ && … } &` subshell, a second `{ … } &`, and `wait -n`.

Two things follow from putting `case` at the very top:

- `doctor` no longer prints the `STORAGE_DIR` warning. That is probably right — the doctor has
  `storage.writable` of its own — but it should be a decision recorded in the diff, not a
  side effect of where the `case` landed.
- The `ensure-secrets && doctor &&` lines must go **inside** the existing `{ cd /app/server/
  && … }` block. Placed outside it they run from the image's working directory, and
  `node /app/server/scripts/...` would still work by absolute path while anything the scripts
  resolve relatively would not.

`exec` for the doctor branch is correct and the plan's reason is right: the file ends with
`wait -n; exit $?`, which would otherwise discard the doctor's exit code.

## OBS-5 — Task 3's evidence is a one-time manual run, so nothing prevents regression

The plan is honest that a shell file cannot be reached by `--findRelatedTests`, and records a
manual `docker compose run --rm anything-llm doctor` in the ledger instead. That proves it
worked once. Nothing then stops someone changing `&&` to `;` — which silently converts "stop
the boot on a blocking failure" into "log it and boot anyway", the exact failure the ordering
exists to prevent.

A jest test that reads `docker-entrypoint.sh` as text and asserts three things closes most of
it cheaply: `ensure-secrets` appears before `migrate deploy`, they are joined by `&&` rather
than `;`, and the `doctor)` branch uses `exec`. Text assertions are weak, but #73 is the
argument for taking a weak guard over none: a check that has never been red is not yet shown
to stop anything, and a check that does not exist has certainly never stopped anything.

---

## Mutation list — doctor and ensure-secrets

| # | mutation | must be caught by |
|---|---|---|
| M1 | `db.version` downgraded `block` → `warn` | "any block failure yields exit 1" — needs a case **per check**, not one representative |
| M2 | `ext.permitted` commits instead of rolling back | a test asserting the extension is **absent** after doctor runs |
| M3 | `ext.available` and `ext.permitted` merged into one line | plan test 5 |
| M4 | `db.locale` upgraded `warn` → `block` | plan test 2 (locale failure alone still exits 0) |
| M5 | one check returns `ok:false` with no `remedy` | plan test 1 — must loop every check, not spot-check one |
| M6 | `require("../index")` added to the check module | plan test 4 (`API_KEY_PEPPER` unset) |
| M7 | `ensure-secrets` overwrites an existing value | plan test 3 |
| M8 | `ensure-secrets` generates `AUTH_TOKEN` as well | **the test ruling (5) mandates** — it must exist as an assertion, not as an absence from a list |
| M9 | `writeEnvFileAtomic` returns false and the script still exits 0 | plan test 2 (symlink) |
| M10 | backup notice removed | plan test 5 |
| M11 | `ensure-secrets` prints a generated value to stdout | **not covered by the plan** — see below |

**M11 is the one I would add first.** Nothing in the plan asserts that the generated secrets
stay out of the output. `ensure-secrets` runs in the container entrypoint, so its stdout lands
in `docker logs`, in CI job output, and in whatever the operator pastes into an issue when
something goes wrong. A helpful `console.log` naming what it generated is a natural thing to
write and would put four instance secrets into every one of those places. This is the same
shape as the S11 invite-code finding: a credential written to a sink that is designed to be
exported. Assert that stdout contains none of the four generated values.

**M8 second**, because ruling (5) already requires the test and a list is not an assertion:
the only thing standing between the ruling and a regression is a test that fails when
`AUTH_TOKEN` appears in the written file.

## Verified by execution

```
require("./utils/chatSearch/localeSupport")   with API_KEY_PEPPER unset -> loads
require("./utils/helpers/updateENV")          with API_KEY_PEPPER unset -> loads
```

So ruling 2f (the check module must load without a pepper) is achievable with the
dependencies the plan chose — neither pulls in `apiKeySecurity`.

Everything else above is read from `approof/main` at `c7ef9d28`:
`utils/middleware/validatedRequest.js:29-36`, `endpoints/system.js:400-405`,
`utils/helpers/updateENV.js:1834-1841` (`INSTANCE_AUTH_KEYS`), `:1886-1889`
(`clearStoredCredential`), `:1929-2012` (`protectedKeys`), `:2056-2112`
(`writeEnvFileAtomic`), `utils/chatSearch/localeSupport.js:34-55`,
`docker/docker-entrypoint.sh`.
