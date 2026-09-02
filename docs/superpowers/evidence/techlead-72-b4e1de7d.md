# Techlead-1 review — #72 `b4e1de7d` (Dev1) — **PASS**

Delta reviewed against my pre-read baseline `e207e124`:
`068c4e5ca` (harden refused responses) · `ba1025a73` (keep hub key writable) ·
`bac9c1184` (hub persistence test) · `b1b084617` (writable-overlap invariant) ·
`b4e1de7d2` (ledger). Runtime delta is 5 files / +47 −15.

Per §7.14 I ran no suites — only in-process `node -e` probes against the worktree's
own `systemSettings.js`, listed under Reproduction.

---

## Pre-read FINDING-1 — CLOSED

The three unmocked end-to-end tests are now parameterised over both direct routes:

```js
const directRoutes = [
  ["admin route", "/api/admin/system-preferences", () => auth()],
  ["v1 route",    "/api/v1/admin/preferences",     () => `Bearer ${apiSecret}`],
];
```

`unknownKeyRefusalHttp.test.js:154` (mixed keys, DB snapshot unchanged), `:180`
(all-unknown), `:192` (all-valid writes the row) each run twice. That was the gap:
`/v1/admin/preferences` previously reached 400 only through a mocked model. The
community-hub route gets its own real HTTP test at `:206`, asserting `400` **and**
`not 500` — the right assertion, since the failure mode there was the catch block
swallowing the refusal into a 500.

## The `protected_keys` classification is correct, and I verified the arithmetic

`protectedFields` is 3 keys; the classifier is `protected && !supported`, so:

```
protected AND supported (=> writable):   ["hub_api_key"]
protected NOT supported (=> refused):    ["multi_user_mode", "onboarding_complete"]
```

Executed against the worktree model with `_updateSettings` stubbed:

```
multi_user_mode        code=protected_keys  success=false
onboarding_complete    code=protected_keys  success=false
hub_api_key            code=-               success=true   wrote:hub_api_key
mixed prot+unknown     code=protected_keys  success=false      <- protected wins
mixed unknown+valid    code=unknown_keys    success=false
hub+unknown            code=unknown_keys    success=false      <- hub is not protected-classified
```

Filter order is **protected → unknown → write**, which is what my #78 pre-read
recommended and what makes a mixed body answer unambiguously. The two refusal sets
are disjoint by construction, so no body can be classified both ways.

`ba1025a73` is the right call: `hub_api_key` is `protected` in the sense of "not
public", not in the sense of "not writable" — it is the one field
`/community-hub/settings` exists to write. Excluding it by the supported-set
intersection rather than by removing it from `protectedFields` keeps its
non-public status intact.

## The mutations I ran on the pre-read still fire

Both of my original mutations are dead, which is the point:

- **error-string parsing** — `grep -rnE "Unknown setting|Protected setting|error\.(includes|match)"` over `server/endpoints/` returns **nothing**. Every route now switches on `result.code`. A write failure whose message happens to contain "unknown" can no longer be misclassified 400.
- **drop the `code` branch** — mutating `["unknown_keys","protected_keys"].includes(code)` back to `code === "unknown_keys"` moves `protected_keys` from 400 to 500, and the parameterised mapping test at `:276` (all four routes) goes red.

Reflection is bounded as ruled: 50 keys max, 64 **code points** per key with `[...key]`
so a 64-emoji key is not cut mid-surrogate, and `unknownKeyCount` carries the true
count. `safeUpdates = Object.create(null)` plus the null-prototype assertion at `:120`
and the three `__proto__`/`constructor`/`prototype` HTTP cases at `:261` close the
pollution path at the layer that parses.

---

## NIT-1 — `protected_keys` is proven at the model and proven at the mapping, never end to end

Both HTTP tests that exercise `protected_keys` (`:276`, and the shape at `:295`) get
there through `jest.spyOn(SystemSettings, "updateSettings").mockResolvedValue(...)`.
The model test proves classification; the mocked route test proves the status map.
Nothing proves the composition — no test posts `{multi_user_mode: "true"}` to a real
route and observes 400.

This is the same shape as the pre-read's FINDING-1, one level down: *a mock that
proves the mapping but not the path*. It is a NIT rather than a finding because both
halves are individually covered and the middle is a plain function call. One line
added to `directRoutes`'s table closes it.

## NIT-2 — the writable-overlap invariant locks in the wrong direction

`:219` asserts `overlap.length > 0` and that each overlap key writes. That protects
`hub_api_key` from being re-broken. It does **not** notice a key moving the other
way. Probe — push `multi_user_mode` into `supportedFields` and re-run:

```
--- drift: add multi_user_mode to supportedFields ---
multi_user_mode now: code=-  success=true  wrote:multi_user_mode
```

A protected key silently becomes writable, and the invariant test stays green
because the overlap only grew. Pin the **exact set** — `expect(overlap).toEqual(["hub_api_key"])`
— so a fourth entry is a deliberate edit rather than a side effect. Same argument
as #40: a lower-bound guard cannot see a population changed at the top.

## NIT-3 (carry to #78, not a #72 blocker) — the forbidden list guards one route of three

#78 is about to make 23 supported keys manager-forbidden at
`/admin/system-preferences`. Two of those 23 are writable by the same principal
through other routes that #72 touched and #78 does not:

| key | other route | gate | manager (`setup_admin`) |
|---|---|---|---|
| `hub_api_key` | `POST /community-hub/settings` (`communityHub.js:33`) | `settings.write` only | **can write** |
| `default_system_prompt` | `POST /system/default-system-prompt` (`system.js:1007`) | `settings.write` only | **can write** |

`setup_admin` holds `settings.write` and not `system.write`
(`20260902020000_t1_authz_schema:302`), so the narrowing at `admin.js:591` is the
only thing standing between a manager and those keys — and neither of these routes
has it. QA-3 already noted `default_system_prompt` is off the #78 route; the point
here is that being off the route means being **ungoverned**, not out of scope.

Not a #72 defect: both routes predate it and #72 only changed their status mapping.
But #72 is what makes `hub_api_key` deliberately writable, so the pair should be
ruled on together.

---

## Verdict

**PASS.** Merge as is. NIT-1 and NIT-2 are one-line test changes and can ride the
next SHA; NIT-3 belongs to #78's plan.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/pr72/server
node -e '<set arithmetic on protectedFields x supportedFields>'   # 28 / 3 / 1 overlap
node -e '<updateSettings with _updateSettings stubbed, 6 bodies>' # table above
node -e '<same, after pushing multi_user_mode into supportedFields>'
grep -rnE "Unknown setting|Protected setting|error\.(includes|match)" ../server/endpoints/   # 0
```

Read-only: nothing in the worktree was modified.
