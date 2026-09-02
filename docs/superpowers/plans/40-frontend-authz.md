# Plan — #40 frontend authz: capabilities endpoint + `can(action)` replaces role strings

Base: `8d25b3bb` (approof/main, after #53 merged) · mockup `cf7ed8ad`
(`docs/superpowers/mockups/frontend-authz-capabilities.html`, blob `2a30aa21`) — user confirmed.
Contract: issue #40 comment `#issuecomment-5505480941`, state `.infi/task-40.env`.

Out of scope, tracked as **#66 (#40b)**: workspace-scoped UI sites.

## What exists today

`/system/my-capabilities` (`server/endpoints/system.js:1348`) answers ONE resource — a hardcoded
org (`{type:"org", id:"1", orgId:1, workspaceId:null}`) — over a 6-entry `ORG_CAPABILITIES` list
(`:101`). One consumer: `frontend/src/models/system.js:794 fetchCanViewChatHistory`, which reads a
single key and throws the rest away.

Frontend has **35 role-string sites in 25 files**. Not all are authorization: `msg.role ===
"assistant"` (chat message roles) and `AddMemberModal`'s list filters are not. The authorization
subset is **21 sites in 16 files**.

## Task 1 — `WORKSPACE_CAPABILITIES` + `ACTION_SCOPES` as validator (server, no route change)

RED first: `server/__tests__/security/authorization/workspaceCapabilities.test.js`.

Add `WORKSPACE_CAPABILITIES` beside `ORG_CAPABILITIES` in `server/endpoints/system.js` and export
both for the test. Members — **exactly** the approved mockup's `WS_CAPS` (`frontend-authz-capabilities.html:150`),
seven entries: `workspace.read`, `workspace.write`, `workspace.delete`,
`workspace.members.manage`, `document.create`, `document.delete`, `chat.send`.

An earlier draft of this plan listed twelve, invented rather than copied from the mockup. Two of the
five extras were not merely unapproved but wrong: `document.update` has no `requirePermission` gate
anywhere in the tree, and `document.search` is gated only at `orgResource` — both would have been
capabilities the UI could ask about that no route decides. A third, `workspace.members.manage`, was
in the mockup and got dropped. Actions with real workspace gates that the mockup does not list
(`document.read`, `document.pin`, `document.watch`, `chat.read`) stay out; whether to widen the list
is an open question on #66, not a decision to make here.

Add `workspace.create` to `ORG_CAPABILITIES` — genuinely org-scoped, confirmed by two server gates
at `orgResource` (`workspaces.js:58`, `admin.js:361`). Ruling amended by PMO: the org set is never
*shrunk*, but may grow when a server gate at an org resource backs the entry.

Tests, all five required — the first two are the ruling, the last three stop it going vacuous:

1. no member of `WORKSPACE_CAPABILITIES` declares `ACTION_SCOPES[a] === "org"`
2. no member of `ORG_CAPABILITIES` declares `ACTION_SCOPES[a] === "workspace"`
3. both lists `length > 0`
4. every member of both lists exists in the seed vocabulary (`ALL_ACTIONS`) — catches typos, which
   would otherwise surface as a silently-false capability rather than an error
5. every member of `ORG_CAPABILITIES` has at least one `requirePermission(<action>, orgResource)`
   gate in `server/endpoints/` — this is what makes `workspace.create`'s admission a rule rather
   than an exception. Scan the endpoint tree; do not hardcode a list.

6. **every member of `WORKSPACE_CAPABILITIES` has at least one `requirePermission` gate at a
   workspace-bearing resolver** — the counterpart to assertion 5. Its absence in the first draft is
   exactly how `document.update` and `document.search` got in unnoticed. Prove red by re-adding
   `document.update`.

Tests 5 and 6 are the ones that rot into tautologies, and 5 already did once: a purely lexical scan
went green when both live gates were deleted and replaced by a commented-out
`// requirePermission("workspace.create", orgResource)`. It proved a string existed in a file, not
that a route decided anything. **Strip comments and string literals before scanning**, assert the
scan collected sources at all, and assert `workspace.create` is found specifically in `workspaces.js`
and `admin.js`. Prove each red with a mutation — including the commented-gate one — before believing
any of them.

## Task 2 — endpoint answers workspace scope

`GET /system/my-capabilities` keeps its current org-only response shape when called with no query.
Adding `?workspaceId=<id>` additionally answers `WORKSPACE_CAPABILITIES` against
`{type:"workspace", id:String(id), orgId:1, workspaceId:Number(id)}`.

```
{ capabilities: { "user.manage": true, ... },
  workspace: { id: 3, capabilities: { "workspace.write": false, ... } } }
```

Two properties the tests must pin:

- **A bad `workspaceId` is not an error and not an allow.** A non-numeric or unknown id answers
  `workspace: null`, never a partially-true map. The endpoint gates affordances; a caller that can
  ask about a workspace it cannot see learns nothing from `false`.
- **The org half survives a workspace-half failure.** `authorizeMany` re-throws a contract error
  for the whole batch (see the `#53` comment at `system.js:93`), so the two batches must be
  separately awaited and separately caught. If they share one `try`, one org-scoped action asked at
  workspace scope takes down every org capability — the exact failure that comment warns about.

Existing `myCapabilities.test.js` must stay green untouched: the no-query shape is unchanged.

## Task 3 — frontend `can()`

`frontend/src/models/system.js`: add `fetchMyCapabilities({ workspaceId } = {})` returning
`{ capabilities, workspace, error }`, failing closed to `{}` on any error — same as the existing
`.catch(() => ({ capabilities: {} }))`.

Rewrite `fetchCanViewChatHistory` to call it. Keep the exported name and return shape
(`{viewable, error}`) — 3 call sites depend on it and this issue does not touch them.

New `frontend/src/hooks/useCapabilities.js` exposing `{ can, loading, error }`, session-cached (a
module-level promise, not `localStorage` — a grant an admin can revoke cannot outlive the tab; the
comment at `system.js:783` already argues this).

`can(action)` returns `false` while loading. The mockup shows a skeleton for that state, not a
flash of a hidden control, so components read `loading` where the mockup shows a skeleton.

## Task 4 — org sites → `can(action)`

21 authorization sites, 16 files. Mapping, from the server gate that actually decides each one:

| site | now | becomes |
|---|---|---|
| `PrivateRoute:89` (`AdminRoute`) | `role === "admin"` | `can("settings.write")` |
| `PrivateRoute:118` (`ManagerRoute`) | `role !== "default"` | `can("user.manage")` |
| `SettingsButton:11` | `role === "default"` | `can("settings.write")` |
| `SettingsSidebar:118,169` | `role !== "admin"` | `can("settings.write")` |
| `Sidebar:161` | `role !== "default"` | `can("workspace.create")` |
| `Sidebar:193` (`NewWorkspaceButton`) | `role === "default"` | `can("workspace.create")` |
| `SearchBox:192` | `role === "default"` | `can("workspace.create")` |
| `Home:146` | `role === "default"` | `can("workspace.create")` |
| `keyboardShortcuts:129` | `role !== "admin"` | `can("settings.write")` |
| `NewUserModal:90` | `role === "admin"` | `can("user.manage")` |
| `EditUserModal:106` | `role === "admin"` | `can("user.manage")` |
| `LLMSelector/action:92` | `role !== "admin"` | `can("settings.write")` |
| `WorkspaceModelPicker:96` | `role !== "admin"` | `can("settings.write")` |
| `ToolsMenu:26` | `role === "admin"` | `can("settings.write")` |
| `Memories:14` | `role === "admin"` | `can("settings.write")` |
| `MemoriesContext:25` | `role === "admin"` | `can("settings.write")` |

The `!user ||` disjunct in most of these is the single-user case, and it must survive: with no
user row there is no principal, and the capability map is empty. Keep `!user || can(...)`, do not
"simplify" it away — dropping it locks single-user deployments out of their own settings.

## Task 5 — DoD 3, the sidebar bug (RED first)

`Sidebar/index.jsx:193` hides `NewWorkspaceButton` from every `role === "default"` user. A default
user holding an `editor` grant on a workspace may in fact create workspaces if granted
`workspace.create` — the role string cannot see the grant, so the affordance is wrong.

RED before the fix: a test where the principal is `default`-roled and holds `workspace.create`,
asserting the server says allowed. Then Task 4's rewrite of `:193` is what makes the UI agree.
The test must fail on `8d25b3bb` for the stated reason — a role-string check that never asks.

## Order

1 → 2 → 3 → (4 ∥ 5). Task 1 is pure list + tests and gates everything. Tasks 4 and 5 both edit
`Sidebar/index.jsx`; same implementer, sequential within that file.

## Evidence

`task.sh check --issue 40`. Contract runs the new test file first, then the full server suite —
a green full suite alone proves nothing was broken, not that #40's test exists. If the file is
missing, jest exits non-zero, `&&` short-circuits, no `passed`, gate red.

## Models

Implementer Sonnet, reviewer Sonnet (per infi-dev). Final whole-branch review Opus + `security-review`
— this touches authorization.
