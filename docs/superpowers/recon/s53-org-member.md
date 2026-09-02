# #53 recon — `org.member`: an action that means "is a real principal of this org"

Author: Dev 2. Base `approof/main` after #52 (`cf0b6af2`). Opened by #52's refused addendum.

## 0. The problem, stated precisely

Seven routes gate on `chat.send` while meaning something else entirely:

| route | what the gate is actually asking |
|---|---|
| `GET /workspaces` (workspaces.js:392) | is the caller a principal? handler filters by membership |
| `POST /workspace/search` (:1027) | same — `searchWorkspaceAndThreads` scopes the results |
| `PUT /workspace-chats/:id` (:798) | resolves a chat the caller owns |
| `GET /agent-skills/generated-files/:filename` (agentFileServer.js:31) | handler resolves through the caller's own workspaces |
| `GET /image-generation/generated-images/:filename` (:97) | same |
| `POST /workspace/:slug/chat` (chat.js:33) | genuinely chat.send — **stays** |
| `POST /workspace/:slug/stream-chat` (:133) | genuinely chat.send — **stays** |

`chat.send` became the proxy in T-4a because it was the only permission the org `member` role still held after migration 044000 stripped the workspace actions. It is the wrong word for the question, and #52 made that concrete: T-7's R5 blanket deny refuses every non-read action for an impersonated actor, and `chat.send` is not in `READ_ACTIONS`, so **a view-as-user session cannot list workspaces, search, or fetch a generated file.** That is live on main now, recorded as a #52 residual.

## 1. Why the obvious fix is the 044000 vulnerability again

The tempting move — seed `workspace.read` onto the org `member` role — was measured during #52 on a fresh database:

```
workspace.read on a workspace they are member of:       allowed=true
workspace.read on a workspace they are NOT a member of: allowed=true
workspace_users rows for this user: 0
```

`evaluate()` builds `workspaceScope` as `{ OR: [{workspace_id: null}, {workspace_id: resource.workspaceId}] }`, so an **org-wide grant (`workspace_id NULL`) matches every resource workspace**, and `workspace_users` is never consulted in the grant path at all. Every user holds an org-wide `member` grant, so any permission on that role is a permission on every workspace. This is verbatim what migration 044000 exists to close.

**So the constraint on #53 is not "pick a better action name".** It is: the new action must not be satisfiable by the org-wide grant that every user already holds, for any resource that names a workspace.

## 2. The shape that works

`org.member` answers a question with **no workspace in it**. Two rules make that safe:

1. **It is only ever asked against `orgResource`** (`workspaceId: null`). A route that names a workspace must ask a workspace-scoped action instead — `workspace.read` via `workspaceBySlug`, which the four existing routes already do correctly and which #52 left alone.
2. **It carries no authority.** It means "this caller is a principal of this org and not suspended". The handler still does the filtering, exactly as it does today; the gate only replaces the accident of `chat.send`.

Seed it onto org `member`, `content_moderator`, `setup_admin`, and `super_admin` — everyone. A permission everyone holds is not a permission at all in the escalation sense, which is why it also belongs in **`BASELINE_GRANTABLE`** beside `chat.send` (#52 added that constant for exactly this shape: things whose granting confers nothing).

**`org.member` MUST be added to `READ_ACTIONS` in engine.js.** That is the half that fixes the view-as-user regression, and it is only correct because rule 2 makes the action authority-free.

### The rule that has to be enforced, not just written

Rule 1 is a discipline, and #52's lesson is that disciplines need tests. The engine cannot currently express "this permission is only valid at org scope" — it has no scope check on the permission itself. Two options:

- **(a) Test-only.** A sweep asserting `requirePermission("org.member", ...)` is only ever paired with `orgResource`. Cheap, catches the next author, does nothing at runtime.
- **(b) Engine-enforced.** `evaluate()` refuses an `org`-scoped permission when `resource.workspaceId != null`. Honest, and it is a change to the decision path four tracks depend on.

**Recommend (a) for #53, with (b) recorded as follow-up.** The action is authority-free, so a misuse grants nothing dangerous — it would merely allow something a workspace-scoped gate should have decided. That is a correctness bug, not a privilege bug, and it does not justify touching `evaluate()` in the same issue that introduces the action. Whichever is chosen, decide before writing the migration, because it shapes the tests.

## 3. What #53 must NOT do

- **Must not seed `workspace.read`, `workspace.write`, or any document action onto the org `member` role.** §1. The migration should assert this rather than merely avoid it: a check that `member`'s org-role permission set is a subset of `{chat.send, org.member}` after the migration.
- **Must not touch `evaluate()`'s `workspaceScope`.** Making org-wide grants stop covering all workspaces is a much larger change (it would alter what every existing grant means) and is not what this issue is for.
- **Must not leave `requireSelfSession` in place beside a real action.** #52's residual: if #53 also adds a self-service action, `requireSelfSession` is REPLACED, not kept. Two things answering one authorization question can disagree.

## 4. Owner files

**Modified**
- `server/prisma/seeds/permissions.js` — add `org.member` to the vocabulary and to all four org roles
- `server/prisma/migrations/<next slot>/migration.sql` — grant it to existing roles, idempotent, plus the subset assertion above
- `server/utils/authorization/engine.js` — `READ_ACTIONS` only
- `server/utils/authorization/policyRepository.js` — `BASELINE_GRANTABLE`
- `server/endpoints/workspaces.js` (3 gates), `agentFileServer.js` (2), `endpoints/workspaces.js:798`
- `server/__tests__/security/authorization/routeGateSweep.test.js` — extend with the rule-1 assertion

**Not touched:** `chat.js` — both its gates genuinely mean `chat.send`. Changing them would be the same category error in the other direction.

## 5. RED DoD

1. An impersonated session gets **200** on `GET /workspaces`, `POST /workspace/search`, and both file-server routes, and the list is the VICTIM'S, not the admin's. This is the #52 residual; it fails on main today.
2. An impersonated session still gets **403** on `POST /workspace/:slug/chat` — `chat.send` is a real mutation and stays denied. Without this, #53 reads as "impersonation restrictions relaxed".
3. A user with an org-wide `member` grant and **zero** `workspace_users` rows is **denied** `workspace.read` on any workspace. The 044000 regression, asserted directly rather than trusted — this is the test that would have caught the refused addendum.
4. Same user is **allowed** `org.member` at org scope. The positive control.
5. `setup_admin → member` still allowed, `→ content_moderator` still refused, after `org.member` joins `BASELINE_GRANTABLE` (#52's guard tests, re-run with the new constant).
6. Sweep: no route pairs `org.member` with a workspace-bearing resolver.
7. `git grep 'requirePermission("chat.send"' ` returns exactly the two `chat.js` gates.

Real Postgres, `migrate deploy` from empty (§7.1a).

## 6. Collision

- **#50** (simple-SSO deletion) — touches `endpoints/system.js`; #53 does not. Independent.
- **#52** — merged first; #53 consumes its `BASELINE_GRANTABLE` and its sweep test.
- Nothing else holds `workspaces.js` or `agentFileServer.js`.

## 7. Estimate

Half a day. The work is small; §1 is the whole risk, and the reason DoD 3 is written as a test rather than a note.

## §PMO rulings (2026-09-02)
- org.member: asked against orgResource only, carries no authority, seeded to every org role, in BASELINE_GRANTABLE and READ_ACTIONS. Handlers keep filtering.
- Enforcement of "orgResource only": (ก) sweep test in #53; (ข) evaluate() refusing org-scoped permissions when resource.workspaceId != null → follow-up issue [→ needs issue].
- 5 routes move (workspaces list, search, PUT workspace-chats, 2 file-server); chat.js 2 routes stay on chat.send.
- DoD: org-wide member grant + 0 workspace_users rows → workspace.read DENIED on every workspace; impersonated POST /workspace/:slug/chat still 403.
- requireSelfSession from #52 is REPLACED, not kept alongside.
- SUPERSEDES (ก)-only: (ข) lands in #53 — permissions.scope column ('org'|'workspace'|'any'); evaluate() denies org_scoped_action_on_workspace_resource before lookup when scope='org' and resource.workspaceId != null. org.member is scope 'org'. Engine never reads workspace_users; membership = workspace-scoped grant (044000). (Techlead)
- #53 migration (Techlead): permissions.scope TEXT + CHECK (scope IN ('org','workspace','any')), NOT enum (§7.6 regenerate trap, ALTER TYPE limits). DEFAULT 'any' then same migration UPDATEs known ones: org.member/settings.write/user.manage/key.manage/role.grant/role.revoke/sso.issue → 'org'; document.*/chat.*/workspace.write → 'workspace'; RAISE NOTICE count of remaining 'any'.
- evaluate() order: 1 resource.type contract → 2 scope check (NEW, throws AuthorizationContractError not asDenied — malformed question, same answer for every actor, loud in dev) → 3 R5 impersonation → 4 B-1 binding → 5 policy lookup.

### PMO rulings (2026-09-02, pre-implementation re-measure by Dev2)
- Ruling: `workspaces.js:798` keeps `chat.send` — it mutates the caller's own chat and its resolver returns a workspaceId; not a membership proxy. Proxy routes = 4 (workspaces.js:392,1027; agentFileServer.js:31,97).
- Ruling: `permissions.scope` column + `evaluate()` scope check before R5 (throw AuthorizationContractError) ship in #53, not follow-up. Migration slot 102000, one file: org.member permission (scope='org') + scope column + grants. DoD-6 sweep test stays as second layer.
