# Techlead-2 review — #74 (O2a) `c0c6472b0`, branch `approof/o2-recon`

**Verdict: PASS.** Every finding I raised across three rounds is closed and verified against
the state it was about; my whole pre-review mutation list M1–M11 plus one more runs, and ten
of twelve are caught. The two survivors are both explained below and neither is a coverage
gap in this repository.

Independent worktree `/tmp/tl2-74d` (`git worktree add --detach`), `node_modules`
hardlink-copied from `/tmp/base91`, `prisma generate` run, Node v22.23.1. Per §7.14 no
full-directory run — only `__tests__/scripts/`, and the mutations against it. Worktree clean;
both mutated files restored from backups.

**Three databases, because this subject is sensitive to which one you point it at:**

| container | port | state |
|---|---|---|
| `tl2-stock16` | 55481 | `postgres:16`, `pg_trgm` installed by hand |
| `tl2-fresh16` | 55482 | `postgres:16`, `prisma migrate deploy` applied |
| `tl2-virgin` | 55483 | `postgres:16`, never migrated — what a preflight actually meets |

---

## The headline: 0 failures on all three, which no previous SHA managed

```
:55481  stock16 (pg_trgm installed)     Test Suites: 3 passed   Tests: 92 passed, 92 total
:55482  fresh16 (migrated)              Test Suites: 3 passed   Tests: 92 passed, 92 total
:55483  virgin (never migrated)         Test Suites: 3 passed   Tests: 92 passed, 92 total
```

For comparison, measured by me on the two SHAs before this one:

| SHA | migrated DB | virgin DB |
|---|---|---|
| `3165b913a` | 5 failed | — |
| `f0e263dd6` | 1 failed | **4 failed** |
| `c0c6472b0` | **0 failed** | **0 failed** |

That progression is the whole point of the last two rounds: the suite used to require the
database to be in the state that exists *after* the migration, while the subject under test
is the thing that runs *before* it.

## FINDING-A — closed by making the tests build their own state, which is the better fix

I reported that three tests asserted on `"already installed"` and so passed only on a
migrated database. The ruling asked for `DROP`/`CREATE` in the fixture rather than a regex
that accepts both branches, and that is what landed.

The fixture extension is **`citext`**, and the reason given is right: `pg_trgm` cannot serve
because after migration `20260902100000` its indexes depend on it and `DROP EXTENSION` fails
with 2BP01. The suite drops `citext`, asserts the "permission verified … rolled back" branch,
then in a separate test asserts the extension is **still absent afterwards** — the disclosure
in the message is a claim about behaviour, and that second test is what makes it true rather
than decorative.

`available()` skips rather than lies when a server does not ship the fixture. That is the
correct direction for a test that depends on a server package.

## FINDING-B — closed, and I confirmed the leak it defends against is still real

The test now saves, deletes and restores `process.env.SIG_SALT` around the assertion. I
verified the underlying contamination has not gone away:

```
node -e 'require("./utils/doctor"); …'   →   after require, SIG_SALT = "b20329da4cc98f63b9a…"
```

Prisma's client loads dotenv at import from the path baked into the *generated* client, which
under §7.6c's hardlink workflow is another worktree's `.env`. The value still arrives; the
test no longer depends on it:

```
✓ fails naming the missing key
```

PMO is recording the mechanism as a note under §7.6c, which is the right home — it will bite
any suite that reads `process.env` for a value a `.env` might also carry.

## The VECTOR_DB work — correct, and it reads `getVectorDbClass` the right way

Two separable questions, kept separate:

- `requiredExtensions()` uses **intent** (`meansPgvector`, trimmed and lower-cased), so
  `VECTOR_DB=PGVECTOR` still causes `vector` to be checked. The doctor should inspect the
  install the operator is trying to build.
- `checkVectorDbSpelling()` blocks on **exact spelling**, because `getVectorDbClass` switches
  on the raw string: any other casing falls to the default arm and silently returns LanceDB.

Measured on stock `postgres:16` (which does not ship pgvector):

```
VECTOR_DB unset      ext.available PASS, and says why `vector` was skipped   →  EXIT 0
VECTOR_DB=pgvector   ext.available FAIL "does not ship: vector"              →  EXIT 1
VECTOR_DB=PGVector   ext.available FAIL as well                              →  (intent honoured)
```

The pairing is what makes it useful: a misspelling is caught as a *configuration* blocker
with its own remedy, while still being told what its intended provider would need. The
whitespace case is tested too, and a `.env` is exactly where a trailing space is invisible.

## Mutation results

| # | mutation | result |
|---|---|---|
| M1 | `db.version` `block` → `warn` | **1 failed** |
| M2 | `ext.permitted` COMMITs instead of rolling back | **1 failed** |
| M3 | `ext.permitted` forced `ok` (denial branch dead) | 0 failed — see below |
| M4 | `db.locale` `warn` → `block` | **3 failed** |
| M5 | a check loses its `remedy` | **1 failed** |
| M6 | doctor module `require`s `apiKeySecurity` | **2 failed** |
| M7 | `ensure-secrets` overwrites existing values | **6 failed** |
| M8 | `ensure-secrets` generates `AUTH_TOKEN` too | **5 failed** |
| M9 | write refusal returns exit 0 | **4 failed** |
| M10 | backup notice removed | 0 failed — see below |
| M11 | `ensure-secrets` prints a generated VALUE | **2 failed** |
| M12 | `config.vector_db` `block` → `warn` | **2 failed** |

**M8 and M11 were the two I most wanted caught**, and both are. M11 has two independent
tests: one asserts no generated value appears in the output, and a second asserts no
64-hex-character run appears at all — which catches a leak of some *other* value, or of a key
a future change adds that the first test does not know the name of. That second assertion is
better than what I asked for.

### M3 — survives here, but the denial path is genuinely covered

`ext.permitted` can only report `false` when the role lacks `CREATE`, and every database in
this suite connects as a superuser. So no test in the repo can drive a permission denial —
which is what lets the mutation live.

I checked the branch is real rather than dead, by creating an unprivileged role on
`:55483`:

```
as unprivileged role -> ext.available.ok: true | ext.permitted.ok: false
  detail: Cannot create: citext (42501). permission verified by creating and rolling back, …
```

The path works and reports 42501 as expected. The suite covers the *other* false case — an
extension no server ships — through `checkExtensions(client, ["an_extension_no_server_ships"])`,
asserting `ext.available` fails and `ext.permitted` says "cannot be created by anyone" rather
than blaming permissions. Closing M3 properly would mean provisioning a second role in the
test database; worth a note, not worth blocking, and the mutation only survives because the
harness is privileged rather than because the code is untested.

### M10 — survives on the happy path, covered on the failure path

Removing the backup notice leaves the suite green because "names all four keys" asserts on
the key names, which the *other* log line also carries. The notice is asserted where it
matters most — the refusal path checks `not.toMatch(/BACK THESE UP/)`, so a script that
claims to have generated something it did not persist fails. A `toContain("BACK THESE UP")`
in the positive test would close it for one line of change.

## Also verified

- **OBS-5 became a real test suite, not the text assertion I suggested.**
  `entrypointDispatch.test.js` runs the actual `docker-entrypoint.sh` under `bash` with a stub
  `PATH` and asserts on exit codes and which stubs were invoked — 15 tests, including
  `&&` rather than `;`, `exec` on the doctor arm, ordering of ensure-secrets → doctor →
  migrate, dispatch before the STORAGE_DIR banner, and that the server does not start when the
  doctor blocks. Its header says outright that grepping for a `case` statement would go green
  on a dispatch that does not work. That is stronger than what I proposed and it is the right
  reason.
- The unreachable-database path reports `db.version`, `ext.available` and `ext.permitted` as
  **failed, never ok** — with the comment naming the shape ("an unreachable database would
  otherwise pass its version and extension checks by never testing them"). That is the same
  class as the `unprovableVectorCount` conflation on #30, caught here by construction.
- `maskUrl` replaces the password before `db.reachable` prints the connection string.
- `AUTH_TOKEN` is absent from `REQUIRED_SECRETS` with the reason stated: its absence is the
  correct state of a fresh install and of every "just me, no password" instance, so requiring
  it would block a correctly-installed system.

## Reproduction

```
git worktree add --detach /tmp/tl2-74d c0c6472b0
cp -al /tmp/base91/server/node_modules /tmp/tl2-74d/server/node_modules
cd /tmp/tl2-74d/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       API_KEY_PEPPER=$(openssl rand -hex 32)
for p in 55481 55482 55483; do
  DATABASE_URL="postgresql://postgres:pw@127.0.0.1:$p/t5" \
    env -u VECTOR_DB npx jest __tests__/scripts/ --runInBand
done
```

The unprivileged-role probe created `lowly` on `:55483`, ran `checkExtensions` through it, and
dropped the role afterwards. Mutations were applied to working copies of
`utils/doctor/index.js` and `scripts/ensure-secrets.js`, each restored immediately after its
run.
