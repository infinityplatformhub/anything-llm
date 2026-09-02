# Ledger — #122 (cap the test Prisma pool; disconnect centrally)

## What this issue does NOT claim

Ruling: this change addresses **regime 2 only** — connection exhaustion, which is deterministic
(every test in the run fails, message says `too many clients`, reproduced 3/3). It does NOT claim to
fix regime 1, the varying 1-5 failing suites, because **that trigger is not reproducible**: the
recon's original "40 held connections → 401" was 40 held PLUS 49 idle backends already present
(~89), and today the same three suites pass 17/17 at 48, 63 and 93 of 100 connections — five runs at
the lowest, three at each of the others. — ถ้าผิด: อ้างว่าแก้สิ่งที่ยังไม่รู้สาเหตุ แล้วปิดการสืบสวน

Ruling: the per-suite-schema proposal is NOT opened as an issue. It is the one proposal with no
measurement behind it now that regime 1 is unreproduced, and rewriting 52 files should follow
evidence.

## Measured, before relying on any of it

    prisma pool idle                                2 backends
    after 40 concurrent queries, uncapped          37 backends   (exact, from pg_stat_activity)
    same with connection_limit=3                    3 backends
    60 concurrent queries with a cap               49 ms
    $disconnect releases                           38 → 1

Ruling: Prisma ANNOUNCES `Starting a postgresql pool with 37 connections` and holds **2** until load
arrives — the pool is lazy, so the announced number is a ceiling, not a reservation. Written into
the code comments because the log invites the opposite conclusion, and the difference decides what
capping is worth: it binds only suites doing heavy parallel work, which are the ones crowding others
off the server. — ถ้าผิด: คนอ่าน log แล้วคิดว่าทุกสวีทกิน 37 แล้วประเมินผลของ fix ผิด

## QA-2's finding — and the closed bug it nearly re-opened

Ruling: `forPrismaTest` KEEPS `connection_limit` and supplies a default when absent. QA-2 was right
that deleting it made the cap work everywhere except the suites routed through this helper — a fix
that looks total while three suites keep an uncapped pool, which nobody would go looking for.

**But the deletion was deliberate, not an oversight**, and the existing test named it: "derives
isolated Prisma schema without inheriting pool cap". `.infi/recon/dburl-helper.md` records why —
#21 measured THREE suites failing with `connection_limit=5` present: `t1-authz-migration` (psql
refusing the URI query parameter), `sqlite-to-pg-import` (`db push` past a 5s hook timeout), and
`scheduler.postgres` (`PrismaClientInitializationError`).

Ruling: re-measured rather than argued from history. All three pass with the cap on this branch —
**14/14, 1/1, 3/3**. The psql failure was the actual cause and `forPsql` now strips every query
parameter, which is a different fix that landed in the same issue. So the strip was solving a
problem that no longer exists. The reversal and its reason are written into the test rather than
overwritten. — ถ้าผิด: เปิดบั๊กที่ปิดไปแล้วโดยไม่มีใครรู้ว่าเคยมีเหตุผล

## RF-1 — how the counting is done, and why it is stated

Ruling: every count comes from `pg_stat_activity WHERE datname = current_database() AND pid <>
pg_backend_pid()`, read DURING the run, with `SELECT 1` issued first so the backend is bound. This
is TL-2's RF-1 and it is the error that invalidated my own recon measurement — I reported what my
probe had opened, not what the server held. The reason is a comment in the test file so the next
person does not repeat it.

## RF-2 — the negative control had to change shape

Ruling: the obvious control ("a disconnected client throws") is FALSE — Prisma's own client
reconnects too, so that assertion would pass whether or not the property held. Measured, then
replaced with a control that establishes the reconnect is a real round trip to a live server rather
than a cached answer: a client pointed at a port nothing listens on must reject. — ถ้าผิด: control
ที่ผ่านเสมอ ซึ่งทำให้เทสหลักไม่ได้พิสูจน์อะไร

## RF-3 — ordering in one file, not two

Ruling: the disconnect-then-use ordering is two sequential tests in ONE file. Jest guarantees order
within a file and not between them, so a two-file version would be a test whose premise nothing
enforces.

## Evidence

`connectionBudget.test.js` 10/10 · `postgresUrl.test.js` 3/3.

**RF-5 positive control — full `--runInBand`, cap on, no external holder:**

    Test Suites: 1 failed, 4 skipped, 215 passed, 216 of 220
    Tests:       1 failed, 36 skipped, 2980 passed, 3017
    occurrences of "too many clients": 0

The single failure was `postgresUrl.test.js` — the stale expectation this issue deliberately
reverses, fixed above. Everything else green in one serial run.

**RF-4:** `-t "memo"` → 64 passed with the cap. They count queries, not connections, as expected —
confirmed rather than assumed.

### Mutations — each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| restore `searchParams.delete("connection_limit")` in `forPrismaTest` | `preserves an explicit connection_limit through forPrismaTest`, `supplies a default cap when the caller's URL has none` |
| drop the cap from the pool measurement | `holds far fewer backends under concurrency than the uncapped default` — reports **Received: 37** |
| remove `setupFilesAfterEnv` from jest.config.js | `jest.config.js registers the disconnect setup file` |
| empty the `afterAll` body | `the setup file exists and calls $disconnect in afterAll` |
| set the default cap to `"37"` | `supplies a default cap when the caller's URL has none` |

## TL-2 survivors, closed

Ruling (M2/M3): the disconnect hook releases a resource and asserts nothing, so removing it — or
emptying its body — leaves EVERY test in the repo green. Nothing behavioural can catch that: the
symptom is a missing side effect in a LATER process, on a different machine, under load. So the
configuration itself is asserted — that `jest.config.js` registers the file, and that the file
still calls `$disconnect` in an `afterAll`. A hook that silently stops running is the exact failure
#122 exists to prevent. — ถ้าผิด: fix หายไปเงียบ ๆ แล้วอาการกลับมาโดยไม่มีใครโยงกลับได้

Ruling (M4): `toContain(\`connection_limit=${DEFAULT}\`)` interpolates the constant it is checking,
so it passes for ANY value — including `37`, the uncapped default this issue exists to replace. The
constant is now bounded independently (integer, > 0, ≤ 10). A test that compares a value to itself
is not a test. — ถ้าผิด: เทสเขียวบน cap ที่ไม่ได้ cap อะไรเลย
