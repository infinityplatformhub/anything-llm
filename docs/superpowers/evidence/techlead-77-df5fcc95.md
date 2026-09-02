# Techlead-1 — #77 rate limit read per request, `df5fcc95`

Reviewed: `5610e098..df5fcc952` (Dev3, `approof/s3-ldap`).
Verdict: **PASS.** No blocker, no major. Two NITs.

Diffstat: 4 files, +118/-1 — `requestControls.js` (+16/-1), new test block (+92), two identity suites
(+10 hygiene).

## The change works, and I verified the mechanism rather than the intent

`limit: integerEnv(...)` → `limit: () => integerEnv(...)`. express-rate-limit is pinned at `7.5.1`,
which supports a function for `limit`. Built a standalone limiter with a function limit and drove it:

```
env=2 → 1:200 2:200 3:429      (ceiling honoured)
env raised to 5 mid-flight → 4:200 5:200 6:429
env tightened to 1 → 429 immediately
```

Both directions take effect on a running process. The tightening direction is the one that matters
under attack and it works — the comment says so and it is true.

## `windowMs` staying load-time is correct, and the stated reason is the real one

I checked the coupling rather than taking the comment's word for it. `BoundedMemoryStore.init(options)`
(`requestControls.js:16-18`) caches `options.windowMs`, and `increment` uses that cached value to
compute `resetTime: new Date(now + this.windowMs)` for every new entry. express-rate-limit calls
`init()` once. So a per-request `windowMs` would leave entries created before and after the change
expiring on different schedules, with nothing recording which is which. Freezing it is right, and
"windows change far less often than limits" is a fair justification for the asymmetry.

The comment above the store — one store per limiter, never replaced, because `resetRequestControls`
holds that exact object and other suites call it in `beforeEach` — is also accurate and worth having
written down; a fresh store per request would silently break every suite that resets between tests.

## The fallback survives the change

`integerEnv` is unchanged; only *when* it runs moved. Verified the three cases the test asserts:
malformed (`"not-a-number"`) and unset both fall back to the built-in default, so a typo cannot turn an
endpoint unlimited. That is the failure mode a per-request read could plausibly introduce, and it is
covered.

## Test quality

Four cases, and they are not four spellings of one property:

- **raise** and **lower** are separate tests, because a limiter could conceivably honour one and not
  the other (a cached counter comparison would).
- **malformed/unset fallback** — the regression a per-request read invites.
- **QA-3's probe kept as a regression on a *different* limiter** — `loginAccountRateLimit`, keyed on
  `ip+username`, versus `inviteRateLimit`, keyed on `ip`. These are separate `limiter()` calls, so one
  consulting the environment late proves nothing about the rest. The comment records their measured
  pre-fix result (`200,200,429,429,429`) rather than asserting the fix in the abstract.

The RED is genuine: with the limit frozen at load, test 1's third request stays 429 forever.

## Suite hygiene — right diagnosis

`ldapRoutesHttp` and `samlRoutesHttp` set rate-limit env at **module scope** (the app is built at
require time), and Jest isolates the module registry per file but **not `process.env`**. Before this
change a leftover value was inert, because every limiter had already frozen its number at load. Now it
is live: another suite's limiter would read it. The `afterAll` deletes are the correct fix and the
comment states exactly that reasoning.

I swept for other suites that set rate-limit env and would need the same treatment:

```
requestControlsHttp.test.js       5 set / 1 delete
ldapRoutesHttp.test.js            2 set / 2 delete
samlRoutesHttp.test.js            1 set / 1 delete
```

No fourth suite touches these variables. The two identity suites are now balanced.

## NIT-1 — `requestControlsHttp.test.js` sets five rate-limit variables and its `afterEach` cleans four
The `afterEach` deletes `IP_ALLOWLIST`, `LOGIN_ACCOUNT_RATE_LIMIT_MAX`, `LOGIN_IP_RATE_LIMIT_MAX` and
`LOGIN_RATE_LIMIT_WINDOW_MS` — but the new block sets `INVITE_RATE_LIMIT_MAX` (four times) and the
last test's `delete` only runs if that test reaches its end. If it fails partway, `INVITE_RATE_LIMIT_MAX`
leaks to whatever runs next in the same worker, which is the exact hazard this PR just fixed in two
other files. One line in the existing `afterEach` closes it. Low severity — the leaked value would be
`10` or `50`, both permissive, so the failure mode is a missed 429 rather than a false one — but it is
the same class the PR is about, in the file that introduced it.

## NIT-2 — `LOGIN_ACCOUNT_RATE_LIMIT_MAX` is set inside the QA-3 test without a local reset
That test does its own `jest.resetModules()` and sets the variable to `"2"` then `"5"`. The suite's
`afterEach` does delete it, so nothing leaks past the file — noting only that the test relies on the
shared `afterEach` rather than cleaning what it set, which makes it order-dependent if the `afterEach`
list is ever trimmed. Cosmetic.

## What I did not do
Did not run the suite (§7.14). The limiter behaviour table comes from building a standalone
express-rate-limit instance with a function limit under node 22; the store coupling and the env-leak
sweep come from reading the real modules and grepping the test tree. Read-only in that worktree.
