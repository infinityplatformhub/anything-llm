# QA-3 — #140 probe prep (`GET /utils/metrics` exposure)

Baseline fired for real against the mounted route on `/tmp/qa3-137` @ `edd8db6b7`, not read
off source.

## 1. Baseline — unauthenticated, today

```
UNAUTH status: 200
keys: online,version,mode,vectorDB,storage,appVersion
version:    "edd8db6b7cc0399b38fe6aee87d8f43d82c254e2"   (40 chars — the full SHA)
storage:    {"current":868,"capacity":1995}
appVersion: null      mode: single-user      vectorDB: lancedb
```

`app.get("/utils/metrics", …)` (`server/endpoints/utils.js:17`) has **no middleware array
at all** — not `validatedRequest`, not `requirePermission`. Every neighbouring route in the
same file takes `[validatedRequest, requirePermission(...)]`, so the omission is visible in
context.

What leaks to anyone who can reach the port: the exact source commit
(`getGitVersion()` → `git rev-parse HEAD`, `:95`), free and total disk in GB
(`getDiskStorage()` → `check-disk-space`, `:111`), whether the instance is multi-user, and
the vector DB in use.

`version` is `"--"` when `ANYTHING_LLM_RUNTIME === "docker"`, so **the full-SHA case is the
source checkout, which is what a dev/staging box runs**. A probe on a Docker image would
see `"--"` and wrongly conclude the leak is minor — worth saying in the fix's test.

## 2. The dependency that decides the fix's shape

`frontend/src/models/system.js:919` — the **only** frontend caller:

```js
const newVersion = await fetch(`${API_BASE}/utils/metrics`, {
  method: "GET", cache: "no-cache",
})
```

**No `Authorization` header.** It is called by `useAppVersion()` (`hooks/useAppVersion.js`),
which runs in a bare `useEffect` on mount, and the only renderer is
`components/SettingsSidebar/index.jsx`.

So a fix that puts `validatedRequest` on this route **breaks the sidebar version display**
unless the caller is changed too. `fetchAppVersion` swallows the failure
(`.catch(() => null)` and `if (!res.ok) throw`), so the symptom is a silently missing
version, not an error — invisible in a green test run and exactly the kind of regression
that ships. The fix must either add the header at the caller or keep `appVersion`
unauthenticated while gating the rest.

This is the single most likely way #140 ships broken, and it is why PMO's item (5) matters.

## 3. What I will fire on Dev1's SHA

| # | case | expected after the fix |
|---|---|---|
| 1 | unauthenticated | **401/403**, or 200 carrying *only* `appVersion` — whichever the ruling picks; either way **no `storage`, no full `version` SHA** |
| 2 | `member` token | 200, `appVersion` present, **no `storage`** |
| 3 | `super_admin` token | 200, `storage` present |
| 4 | `setup_admin` token | **`storage` present** — it holds `system.read` after #137. Deliberate consequence, not a defect; I will report it explicitly either way |
| 5 | frontend | sidebar version still renders after login — asserted by rendering `SettingsSidebar`, not by reading the fetch |

Case 4 is the one to state in the ledger: #137 widened `system.read` to `setup_admin`, so
gating metrics on `system.read` gives that role disk figures. If the intent is
super_admin-only, the gate needs a different action.

## 4. Mutants

| # | mutation | must |
|---|---|---|
| M1 | drop `validatedRequest` | unauthenticated case red |
| M2 | drop the `system.read` check, keep `validatedRequest` | `member` case red (member reaches `storage`) |
| M3 | return `storage` for everyone regardless of capability | cases 1 and 2 red |
| M4 | return the full `version` SHA to an unauthenticated caller while hiding `storage` | red — **the half-fix**: hiding disk while still leaking the commit is the plausible partial that a `storage`-only assertion would pass |
| M5 | gate the whole route so `appVersion` is unauthenticated-unreachable | case 5 red — the sidebar regression above |
| M6 | assert-shape trap: if the suite checks `res.status` only and not the body keys, M3 survives | check on the suite, not the code — I will run it |

M4 and M5 are the two the obvious test set misses: one leaks the thing nobody remembered to
assert, the other breaks the only consumer.

## 5. Sequencing and housekeeping

Fire after the #121 chain, on Dev1's SHA. Baseline above is from `edd8db6b7`; I will
re-measure on his base rather than carry these numbers.

Probe script was copied into `/tmp/qa3-137/server` to resolve `express`, run, and deleted;
`git status --porcelain` clean. Database `qa3_138` reused read-only. No commits.
