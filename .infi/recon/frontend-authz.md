# Recon — frontend authorization after T-4a

For a month-2 issue. Base `approof/main` @ `b2a578c5`, after T-4a (#25) merged.

## 0. The headline, stated accurately

**Nothing is broken today.** `users.role` still exists (`schema.prisma:72`), `filterFields` still returns it (`models/user.js:92-99`), and every frontend check still evaluates correctly.

T-4a deliberately kept it that way. `legacyRoleGrants.js:9` says so: *"R4 keeps `users.role` frozen rather than dropped, so the two must agree until a later task removes the column."* Writes go through `syncLegacyRoleGrant` (`models/user.js:142, 216, 252`), which mirrors role changes into `principal_role_grants`.

So this is not an outage report. It is about **what happens the first time the two disagree**, and about a gap that already exists in one direction.

## 1. What the 52 references actually are

The raw count is misleading. Split by kind:

| Kind | Count | Relevant? |
|---|---|---|
| `role === "user"` / `"assistant"` | 20 | **No** — chat message authorship, not user roles. Unrelated code that shares a word. |
| `role === "admin"` / `"default"` / `!== "admin"` | ~19 | **Yes** — the real surface |
| other `.role` reads | rest | mixed |

So the issue is ~19 sites in ~14 files, not 52 in 32. Anyone scoping this from the raw grep will over-estimate it by a factor of three.

## 2. The real sites, grouped by what breaks when role and grants disagree

**Tier 1 — whole-page gates.** Wrong here means a user sees a blank app or an admin loses the admin area.
- `components/PrivateRoute/index.jsx:89` — `isAuthd && (user?.role === "admin" || !multiUserMode)`. The `|| !multiUserMode` is the same bypass shape T-4a removed server-side; it is correct here only because single-user mode has one operator.
- `components/SettingsSidebar/index.jsx:118,169`
- `components/SettingsButton/index.jsx:11`

**Tier 2 — navigation.** Wrong here means a feature is invisible but reachable by URL.
- `components/Sidebar/index.jsx:193`, `Sidebar/SearchBox/index.jsx:192`
- `pages/Main/Home/index.jsx:146`
- `utils/keyboardShortcuts.js:129`

**Tier 3 — controls inside a page.** Wrong here means a button is hidden or present without matching the server.
- `pages/Admin/Users/NewUserModal/index.jsx:90`, `UserRow/EditUserModal/index.jsx:106`, `Users/index.jsx:148`
- `pages/WorkspaceSettings/AgentConfig/index.jsx:88`, `Members/AddMemberModal/index.jsx:65`
- `WorkspaceChat/.../Memories/index.jsx:14`, `MemoriesContext.jsx:25`, `PromptInput/LLMSelector/action.jsx:92`, `ToolsMenu/index.jsx:26`, `WorkspaceModelPicker/index.jsx:96`

## 3. The gap that exists **now**, not later

`ORG_ROLE_FOR_LEGACY = { admin: "super_admin", manager: "member", default: "member" }` — the mapping is **many-to-one**. Role → grants is well defined; **grants → role is not**.

Consequences today:

- **Workspace-scoped grants have no role to show.** Membership now carries the grant (`syncWorkspaceMembershipGrant`, default `editor`). A `default` user who is an editor of three workspaces is `role === "default"` to every check in §2 — so `Sidebar/index.jsx:193` hides the sidebar from someone the engine will happily authorize.
- **T-7 will make it worse by design.** #31 introduces admin duties as separable permissions. The moment someone holds `chat.read_others` without being `admin`, no frontend check can express that: there is no role string for "admin minus one duty". T-7's whole premise is a state the UI cannot represent.

That is the actual finding: **the frontend can only ask a question the backend has stopped answering.** Not "the literals are stale" but "role is a lossy projection of grants, and the UI reads the projection."

## 4. What to build

**Not** a find-and-replace of literals for a `ROLES` constant. That keeps the same question and changes its spelling.

**A capability endpoint** — and it is already being built. **PMO ruling: the endpoint moves to T-7 (#31)**, where Dev2 has `GET /system/my-capabilities`. This issue is now the **UI half only**.

The server already knows the answers: `engine.authorizeMany` resolves a list of actions for an actor in one call, capped at 500 (T-4a W-6), so a page's worth of questions is one request.

```
GET /system/my-capabilities  → { "user.manage": true, "system.write": false, ... }
```

Frontend caches per session and asks `can("user.manage")` instead of `role === "admin"`.

**This issue depends on T-7 shipping that endpoint.** It also wants `assertAuthorized` on the routes the UI mirrors — T-4a landed internal routes, T-4b lands `/v1`, and T-7 follows both, so the ordering already holds.

## 5. DoD

1. *(T-7, not this issue)* `GET /system/my-capabilities` returns a decision per action for the session actor, computed by the engine — no role strings in the handler. Listed here because this issue cannot start until it exists.
2. Every Tier 1 and Tier 2 site in §2 uses it. Tier 3 may follow in a second PR; page-level gates are where a wrong answer is worst.
3. A test: a `default` user with a workspace `editor` grant **sees the workspace UI**. This is the §3 case and it fails today.
4. A test: an actor holding `chat.read_others` without `role === "admin"` sees the control it gates. This is T-7's shape, and asserting it now stops the UI from being rebuilt when #31 lands.
5. `git grep -nE 'role ===? *"(admin|manager|default)"' -- frontend/src` returns only chat-authorship sites. Add the count to checklist §2.3, which currently counts 32 files and should count the ~19 real sites.
6. `PrivateRoute`'s `|| !multiUserMode` either goes, or carries a comment saying why single-user mode is exempt. It is the last instance of the bypass shape T-4a removed everywhere else.

## 6. Collision

`frontend/src` settings zones are lane D's (execution-schedule §"Middleware auth"). With the endpoint in T-7, the split the recon asked for is already the plan: **engine owner writes the endpoint (T-7/Dev2), lane D converts the UI (this issue)** — nobody crosses the boundary.

#15 E2E is a partial witness: scenario 10 (*"member cannot see admin UI or hit admin routes"*) exercises Tier 1 for one role. It does not cover §3's divergence, because the E2E fixture creates users whose role and grants agree.

## §PMO rulings (updated)
- Part (A) capabilities endpoint = T-7 #31 (`GET /system/my-capabilities`). #40 = part (B) UI can() only, lane D, after #31.
- Bug to test first: default user with workspace editor grants has sidebar hidden (Sidebar/index.jsx:193).
