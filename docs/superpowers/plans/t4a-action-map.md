# T-4a route → action mapping (binding for the sweep)

Vocabulary is `server/prisma/seeds/permissions.js`, verbatim (A-R2 — one namespace,
no translation layer). **Never invent an action.** If a route needs one that is not
seeded, stop and report it rather than adding to the seed (that is T-1's file).

## Legacy pattern → what it meant → what it becomes

| Legacy | Meant | Becomes |
|---|---|---|
| `flexUserRoleValid([ROLES.all])` | any authenticated user | the action the route actually performs, scoped to its resource. **Not** a free pass — every one of these still gets a real action. |
| `flexUserRoleValid([ROLES.admin, ROLES.manager])` | workspace-level power | the mutating action on the workspace resource |
| `flexUserRoleValid([ROLES.admin])` | instance-level power | `settings.write` / `user.manage` / `key.manage` on `orgResource` |
| `strictMultiUserRoleValid([...])` | same, but denies in single-user mode | identical treatment. The single-user principal is a real principal (R5); "strict" was a bypass workaround, not a policy. |

## Resource resolvers (`utils/middleware/resourceResolvers.js`)

- `workspaceBySlug` — routes with `:slug`
- `workspaceByIdParam("id")` — routes with a numeric workspace id
- `chatByIdParam("id")` — chat routes; scopes to the workspace CONTAINING the chat
- `documentInWorkspaceBySlug` — routes taking `documentLocation` in the body
- `orgResource` — instance-level routes with no narrower subject

Add a resolver when a route addresses something the list does not cover. The rule it
must obey: **workspaceId comes from the stored row, never from the request body or a
caller-supplied path** (B-3, G11).

## Action by area

| Route area | Read | Write | Delete |
|---|---|---|---|
| workspace itself | `workspace.read` | `workspace.write` | `workspace.delete` |
| workspace members | — | `workspace.members.manage` | `workspace.members.manage` |
| documents in a workspace | `document.read` | `document.create` / `document.update` | `document.delete` |
| document pin / watch | — | `document.pin` / `document.watch` | same |
| chats | `chat.read` | `chat.send` | `chat.write` |
| other users' chats | `chat.read_others` | — | — |
| threads | `chat.read` | `chat.write` | `chat.write` |
| invites | `invite.read` | `invite.create` | `invite.delete` |
| users | `user.read` | `user.write` / `user.manage` | `user.manage` |
| system settings | `system.read` | `settings.write` | `settings.write` |
| api keys | — | `key.manage` | `key.manage` |
| embeds | `embed.read` | `embed.write` | `embed.delete` |
| agent flows | `agent-flow.read` | `agent-flow.write` | `agent-flow.write` |
| mcp servers | `mcp-server.read` | `mcp-server.write` | `mcp-server.write` |
| memory | `memory.read` | `memory.write` | `memory.write` |
| model router | `model-router.read` | `model-router.write` | `model-router.write` |
| browser extension | `browser-extension.read` | `browser-extension.write` | `browser-extension.write` |
| scheduled jobs | `scheduled-job.read` | `scheduled-job.write` | `scheduled-job.write` |
| telegram | `telegram.read` | `telegram.write` | `telegram.write` |
| export | — | — | `document.export` / `document.bulk_export` |

## Rules

1. Read each handler before choosing. The action describes what the code DOES, not what
   the URL is called. A GET that triggers a purge is a delete.
2. A route that reads other users' data needs `chat.read_others`, not `chat.read`.
3. Do not change handler bodies except to drop a `multiUserMode(response) ? ... : ...`
   ternary that only existed to route around the bypass, and to replace
   `Workspace.getWithUser(user, ...)` with `Workspace.get(...)` where the gate already
   authorized the workspace. Membership is no longer what decides access.
4. `endpoints/api/**` and `utils/apiKeySecurity/scopes.js` belong to Dev1 (#26) — do not touch.
5. `utils/chats/commands/img.js` belongs to T-5 — do not touch.
