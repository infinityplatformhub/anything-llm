# QA-3 — #137 second commit (Model Router re-gate): staged probe

Staged before Dev1's commit by applying the two-line shape locally on `/tmp/qa3-127`
@ `5c9ea893d` and reverting after. Harness: `/tmp/qa3-mr/{run.sh,apply.py,probe.test.jsx}`.

The probe reads `ORG_CAPABILITIES` **out of `server/endpoints/system.js` at run time** and
builds the capability map from it, intersected with each role's real grants. That is what
makes the trap below visible: a map hand-written in the test would answer `true` for
actions the endpoint never batches, which is the #121 failure exactly.

## The change under test

```js
// server/endpoints/system.js — ORG_CAPABILITIES
+  "model-router.read",
// frontend/src/components/SettingsSidebar/index.jsx:289
-  capability: "system.write",
+  capability: "model-router.read",
```

## Results

| variant | `setup_admin` | Model Router | `super_admin` | Model Router |
|---|---|---|---|---|
| **BASE** (today) | 24 | **visible** | 26 | visible |
| **FIX** (both halves) | **23** | **gone** ✅ | **26** | visible ✅ |
| **M1** — keep `system.write` predicate (sidebar half omitted) | 24 | **still visible** ❌ | 26 | visible |
| **M2** — omit the `ORG_CAPABILITIES` addition (**the trap**) | 23 | gone | **25** | **gone** ❌ |

FIX lands exactly where PMO predicted: 24 → 23 for `setup_admin`, `super_admin` unchanged
at 26.

**M1** is the "did the sidebar actually move" mutant: adding the capability server-side
while leaving the predicate on `system.write` changes nothing visible, so a suite that only
checks `ORG_CAPABILITIES` would pass a half-applied fix.

**M2 is the trap and it bites hard.** Re-gating the entry without adding
`model-router.read` to `ORG_CAPABILITIES` makes the endpoint return no such key, `can()`
answers false for **everyone**, and the entry disappears from `super_admin` too —
`26 → 25`. The fix would look like it worked (`setup_admin` loses the entry, which is the
goal) while silently removing a working page from the only role that can use it. Same shape
as #121's four missing capabilities, one entry wide.

## The 403 this exists to prevent — confirmed against `qa3_121`

```
model-router.read  <- super_admin
model-router.write <- super_admin
GET /model-routers   requirePermission("model-router.read", orgResource)   modelRouter.js:14-15
```

`setup_admin` holds neither, so before this change it saw the entry, opened the page, and
took a 403 on the first list call. After FIX the entry is gone and the 403 is unreachable
from the UI. Both `model-router.*` actions remain `super_admin`-only — the re-gate narrows
the UI to match the server rather than widening the grant, which is option (2) of the three
I put to TL-1.

## What Dev1's commit must also carry

`model-router.read` joining `ORG_CAPABILITIES` needs the same two guards #121 added, or M2
ships unnoticed:

- the sidebar-source pairing test (`workspaceScopedCapabilities.test.js`, "every capability
  the sidebar gates on is answered by the map") — it derives its expectation from the
  sidebar source, so this case is covered **automatically** once the entry names
  `model-router.read`; I will fire M2 against it and it must go red;
- the exact-list test pins `ORG_CAPABILITIES` at **11** and will need **12**. A commit that
  adds the capability without updating that literal fails; a commit that updates the literal
  without adding the capability fails the pairing test. Both directions are already held.

## Firing order

After #121 merges (this measures #121's tree) and on Dev1's actual commit — the numbers
above come from my local reconstruction of the change, not from Dev1's code.

## Housekeeping

Every variant reverted by `git checkout -- .`; the harness verifies the tree is clean before
and after each run and refuses to run on a dirty tree or a missing anchor. `/tmp/qa3-127`
`git status --porcelain` clean. No commits.
