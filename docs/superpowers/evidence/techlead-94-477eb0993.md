# Techlead-1 — #94 O5b `477eb0993` delta (from `cefab9864`, my PASS)

Delta: 4 files, +413/-16 — `diagnostics/index.js` (+131), the two test files, ledger.
Probes in detached worktree `/tmp/tl1-94c` against the real modules; no suite run (§7.14).

**Verdict: PASS.** FINDING-1 is closed on the shipped configurations, NIT-1 is closed and
now has a mutation behind it. Two observations, neither blocking.

## FINDING-1 closed — measured on every host shape, not just the fixture

`scrubText` (`:58-75`) strips `scheme://userinfo@` before `scrubValue` runs, in that order,
and threads `hits` so the removal is reported rather than silent. Applied at every string the
bundle emits: `safeQuery`'s `error` (`:94`), `connection` (`:114`), `serverVersion`,
`migration_name`, event-name keys, and each check's `detail` **and** `remedy` (`:192-200`).

Re-ran my leak probe with the same password across five hosts:

| host | password | `appuser` present |
|---|---|---|
| `postgres:5432` (docker-compose) | clean | no |
| `localhost:5432` (ci.yml) | clean | no |
| `db.internal:5432` | clean | no |
| `db` (bare, no port) | clean | no |
| `127.0.0.1:5432` | clean | no |

All report `redactions: ["url_credentials"]`, so the bundle says something was removed.

The mutation is real. Removing the strip step and keeping `scrubValue`:

```
postgres:5432      LEAKS  -> test RED
db.internal:5432   clean  -> test GREEN
```

which is exactly why the test's `describe.each` carries all three hosts with the dotted one
labelled *"must not be the only one that passes"*. A single-host suite would have gone green
on the mutation. This is the right shape and it is the reason the finding was findable at
all.

`scrubText`'s URL pattern is broader than the leak I reported, which is correct: probed
uppercase scheme (`POSTGRESQL://`), `jdbc:postgresql://`, a bare `user@host` with no password,
and two credential runs in one string — all stripped, host preserved.

## QA-2 FINDING-2 — the prose half, and my read on it

`PG_USER_PHRASE` (`:50`) redacts the account the driver names in `for user "x"`, `role "x"`,
`user 'x'`. Probed all three phrasings plus single quotes: all redacted, `db_username`
reported. Finding the second phrasing only because a test drove a different failure is the
argument for matching the set — same reasoning as the `apw-*-` family, and the comment says
so.

**OBS-1 — it over-redacts English prose, and I think that is the right trade, stated.**
`the user "guide" explains this` → `the user "[redacted]" explains this`. The pattern matches
any quoted token after `user`/`role`/`for user`, which is a common English shape.

Measured the actual cost against the doctor's real `detail` strings — the only prose the
bundle carries today: all seven representative strings I drove
(`LC_CTYPE is en_US.UTF-8…`, extension lists, uid/path messages, `server_version_num is
160004…`, `All four instance secrets are set: JWT_SECRET, …`) come back **unchanged**. So
there is no live over-redaction, and the failure direction is a lost word in a diagnostic
rather than a published account name. Worth one line in the residual so the next person
adding a check that says `the user "config" section` knows why their string arrived redacted.

**OBS-2 — unquoted prose is not covered, deliberately or not.**
`password authentication failed for user appuser` (no quotes) passes through untouched. The
pattern requires quotes. Postgres itself always quotes the role in these messages, so this is
not a live gap; a proxy, pooler, or ORM re-wording the error is where it would appear. I do
**not** think it should be widened — an unquoted rule would eat the next word after every
`user` in every sentence, and OBS-1 is already the boundary of what over-matching is worth.
It belongs in the residual as a stated limit: *the account is redacted where the driver
quotes it, which pg always does; an unquoted re-wording by an intermediary is not covered.*

## NIT-1 closed, with a mutation

The denylist assertion is in (`UNDECLARED ∩ (REQUIRED_SECRETS ∪ secret-declared envKeys)`).
Re-ran my own mutation — adding `API_KEY_PEPPER` to `UNDECLARED_ENV_KEYS` with a plausible
20+ character reason:

```
mutated UNDECLARED ∩ forbidden = ["API_KEY_PEPPER"]  -> RED
collectEnv: {"NODE_ENV":"production","API_KEY_PEPPER":"REAL-PEPPER"}
```

Red now, where every assertion in the previous SHA stayed green while the pepper shipped.

## The `env.DATABASE_URL` seam

`collectDatabase`'s options now take `databaseUrl` **and** `hits`, with the comment that
`buildBundle` always passes `env.DATABASE_URL` so the tests drive the same seam production
uses. That closes the gap where a test could pass `databaseUrl` explicitly while production
read `process.env` — the two are now the same path. Correct, and worth having said out loud.

## One structural note

`hits` is now created in `buildBundle` (`:338`) and threaded down, replacing the local set
that was created after assembly. That is what makes `url_credentials` and `db_username`
appear in `bundle.redactions` at all — a scrub that swallowed its own hits would have made
the bundle claim nothing was removed while removing things, which the comment at `:59-61`
names. The test `names db_username among the redaction classes` pins it. No further comment.
