# Techlead-1 — #84 delta read `f309f1247` (base: `8bcc62ce`, my prior PASS)

Delta = two commits, `4a02b678b` (gate) + `f309f1247` (equality test). 3 files, +66/-1 of
subject code/test. Everything else in the range between the two SHAs belongs to #90 and is
not read here.

**Verdict: PASS.** FINDING-1 is closed on behaviour. One NIT on the new test's mechanism.

Method: source reads plus small in-process `node -e` probes. Per §7.14 I did not run the
suite; the gate run (10/10, 107/107) and QA-2 (17/17) are PMO's.

## FINDING-1 — closed

`server/endpoints/system.js:740` now reads
`[validatedRequest, requirePermission("system.write", orgResource)]`, matching `:764`.
Probed both route strings in the committed file: each occurs exactly once (`:739`, `:763`),
so there is no second mount to disagree with.

Tests added at `updateEnvGateHttp.test.js:56`/`:65` are the shape I asked for:

- refusal asserts **403 and** `CredentialStore.get(secretEnvKey)` still `ORIGINAL_SECRET` —
  status alone would pass against a delete-then-refuse implementation.
- positive control asserts admin gets 200, `{cleared:true}`, and the store value is `null`,
  so the route is proven still functional and not merely refused for everyone.
- both drive `secretEnvKey`, derived from `KEY_MAPPING` by `hasNoHooks` and thrown on if
  absent — no hardcoded key that could silently stop being secret.

## NIT-1 — the equality test goes green when the gate is *removed*

`f309f1247`'s `actionFor(route)` finds the route string, then regex-matches the **first**
`requirePermission(...)` anywhere after it. The scan is unbounded, so it does not verify
that the match lies inside that route's own mount.

Probed three variants of the committed file:

| variant | DELETE | POST | test |
|---|---|---|---|
| as committed | `system.write` | `system.write` | GREEN (correct) |
| DELETE gate renamed `settings.write` | `settings.write` | `system.write` | RED (correct) |
| **DELETE gate deleted entirely** (`[validatedRequest]`) | `system.write` | `system.write` | **GREEN** |

In the third case `actionFor("/system/credential/:envKey")` walks 24 lines past the DELETE
mount and reads the POST route's gate — the two extracted values are literally the same
string because they are the same call site. The relation asserted is "the next gate below
each route name is the same", which the removal satisfies trivially.

This is a guard that fails on shape rather than consequence — the same class as #40 and
#78 in this program, and it is subtractive-blind in the same direction: it detects a gate
*changing* but not a gate *disappearing*.

Not a blocker, because the removal is covered elsewhere: the behavioural refusal test at
`:56` goes red on it (403 → 200 and the store value gone), and the commit message records
that mutation as failing 1 test. The residual risk is only that the equality test does not
add coverage it appears to add, and a later reader may trust it further than it reaches.

Cheap fix, if PMO wants it in a follow-up rather than reopening #84: bound the slice to the
route's own mount, e.g. cut at the next `app.` occurrence —

```js
const at = source.indexOf(`"${route}"`);
const end = source.indexOf("\n  app.", at);      // start of the next mount
const match = source.slice(at, end === -1 ? undefined : end)
  .match(/requirePermission\(\s*"([\w.]+)"/);
expect(match).not.toBeNull();                     // absence is now a failure
```
With that bound, variant 3 fails on `match === null` instead of borrowing the neighbour's
gate, and the "moving both together still passes" property the test was written for is
unchanged.

## OBS-1 — residual counts

Ledger now records the 30 `secret: "url"` keys separately from the 92/92 split, as asked.
The framing ("whether they belong under the same gate is a separate question this issue did
not ask") is the right one to leave behind — a later reader cannot otherwise tell which side
of the count the url-shaped keys fell on.

## Not re-read

`updateENV` is untouched in this delta (boot and other actor-less callers still reach it
directly, which was correct at `8bcc62ce` and is unchanged). `ROUTE_SCOPES` assertion at
`:75` is unchanged.
