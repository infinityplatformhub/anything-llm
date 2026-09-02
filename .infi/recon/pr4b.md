# PR-4b recon — burn down the remaining 52 wildcard routes

Baseline: `approof/main` @ `7dce4997` (+ env7 `bca9b4c8` + t3 `3b80ba34`, neither touches these files).
Counter: `server/__tests__/utils/middleware/apiKeyWildcardSweep.test.js` → `EXPECTED_WILDCARD_ROUTES = 52`.
Single source of truth: `server/utils/apiKeySecurity/scopes.js` (PR-4a established the pattern; extend the same file, do not create a second table).

## How PR-4a did it (copy this exactly)

```js
// scopes.js
const PR4A_ROUTE_SCOPES = Object.freeze({ "GET /v1/admin/users": "user.read", ... });
const scopeFor = (method, path) => PR4A_ROUTE_SCOPES[`${method} ${path}`];

// endpoint
app.get("/v1/admin/users", [validApiKey(scopeFor("GET", "/v1/admin/users"))], ...)
app.get("/v1/admin/workspaces/:workspaceId/users",
  [validApiKey(scopeFor(...), { workspaceParam: "workspaceId" })], ...)
```

`validApiKey(action, binding)` throws if `action` is not a non-empty string, so a missing table entry fails loudly at boot, not silently at request time. Keep that property: **never** add a `|| "*"` fallback in `scopeFor`.

Rename `PR4A_ROUTE_SCOPES` → `ROUTE_SCOPES` in the same PR and keep a `PR4A_ROUTE_SCOPES` alias only if something outside `scopes.js` imports it (checked: nothing does — so just rename).

## Suggested split — 4 PRs, one group each

Groups are file-disjoint, so they can run in parallel with zero merge conflict. Only `scopes.js` and the counter test are shared; each PR appends its own block to the table and drops the counter by its own count.

| PR | Files | Routes | Counter after |
|---|---|---|---|
| 4b-1 workspace | `api/workspace/index.js`, `api/workspaceThread/index.js` | 11 + 6 = 17 | 35 |
| 4b-2 document | `api/document/index.js` | 13 | 22 |
| 4b-3 embed+ext | `api/embed/index.js`, `browserExtension.js` | 6 + 5 = 11 | 11 |
| 4b-4 system+openai | `api/system/index.js`, `api/openai/index.js` | 6 + 5 = 11 | 0 |

If they land in a different order each PR just sets the counter to whatever the sweep reports; the test is the arbiter.

**Merge order note:** all four touch `scopes.js`. Land them one at a time and rebase the rest — the conflict is a trivial append inside one object literal, but four simultaneous appends to the same closing brace will conflict every time. Rebase order is free; pick any.

## Scope table — proposed

Vocabulary continues PR-4a: `<resource>.<verb>`, verbs `read` / `write` / `create` / `delete` / `manage`. New resources here: `document`, `embed`, `thread`, `chat`, `openai`, `extension`.

### 4b-1 workspace (`api/workspace/index.js`, 11)

| Route | Scope | Binding |
|---|---|---|
| POST /v1/workspace/new | workspace.create | — |
| GET /v1/workspaces | workspace.read | — |
| GET /v1/workspace/:slug | workspace.read | `{ workspaceSlugParam: "slug" }` |
| DELETE /v1/workspace/:slug | workspace.delete | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/update | workspace.write | `{ workspaceSlugParam: "slug" }` |
| GET /v1/workspace/:slug/chats | chat.read | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/update-embeddings | workspace.embeddings.manage | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/update-pin | workspace.embeddings.manage | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/chat | chat.write | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/stream-chat | chat.write | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/vector-search | workspace.search | `{ workspaceSlugParam: "slug" }` |

### 4b-1 threads (`api/workspaceThread/index.js`, 6)

| Route | Scope | Binding |
|---|---|---|
| POST /v1/workspace/:slug/thread/new | thread.create | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/thread/:threadSlug/update | thread.write | `{ workspaceSlugParam: "slug" }` |
| DELETE /v1/workspace/:slug/thread/:threadSlug | thread.delete | `{ workspaceSlugParam: "slug" }` |
| GET /v1/workspace/:slug/thread/:threadSlug/chats | chat.read | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/thread/:threadSlug/chat | chat.write | `{ workspaceSlugParam: "slug" }` |
| POST /v1/workspace/:slug/thread/:threadSlug/stream-chat | chat.write | `{ workspaceSlugParam: "slug" }` |

### 4b-2 document (`api/document/index.js`, 13)

| Route | Scope | Binding |
|---|---|---|
| POST /v1/document/upload | document.write | — |
| POST /v1/document/upload/:folderName | document.write | — |
| POST /v1/document/upload-link | document.write | — |
| POST /v1/document/raw-text | document.write | — |
| GET /v1/documents | document.read | — |
| GET /v1/documents/folder/:folderName | document.read | — |
| GET /v1/document/accepted-file-types | system.read | — |
| GET /v1/document/metadata-schema | system.read | — |
| GET /v1/document/:docName | document.read | — |
| POST /v1/document/create-folder | document.folder.manage | — |
| DELETE /v1/document/remove-folder | document.folder.manage | — |
| POST /v1/document/move-files | document.folder.manage | — |
| GET /v1/document/generated-files/:filename | document.read | — |

Two notes for whoever takes this:
- The two schema/type endpoints are static metadata, not tenant data — `system.read` keeps them usable by a read-only key without granting document access.
- Document routes have **no workspace binding available** at the API surface (documents live in a global store; workspace attachment happens later). Do not invent a binding here; T-3 `documentFilter` is the layer that does per-actor document scoping. Say so in the PR body so the reviewer does not ask.

### 4b-3 embed (`api/embed/index.js`, 6)

| Route | Scope | Binding |
|---|---|---|
| GET /v1/embed | embed.read | — |
| GET /v1/embed/:embedUuid/chats | embed.chat.read | — |
| GET /v1/embed/:embedUuid/chats/:sessionUuid | embed.chat.read | — |
| POST /v1/embed/new | embed.create | — |
| POST /v1/embed/:embedUuid | embed.write | — |
| DELETE /v1/embed/:embedUuid | embed.delete | — |

### 4b-3 browser extension (`browserExtension.js`, 5)

These use `validBrowserExtensionApiKey`, a **different credential type** (`apw-brx-` prefix, `browser_extension_api_keys` table), not `api_keys`. The sweep counts them because the regex covers both. Decide one of:

- **(a) preferred** — give the extension its own fixed scope set in code (it is a single-purpose client) and take these 5 out of the `api_keys` scope table entirely. The sweep regex then needs its `validBrowserExtension` alternative dropped and the counter reduced by 5.
- (b) put them in the shared table under `extension.*` and accept that two credential types read one table.

Route list either way:

| Route | Scope |
|---|---|
| GET /browser-extension/check | extension.read |
| DELETE /browser-extension/disconnect | extension.write |
| GET /browser-extension/workspaces | workspace.read |
| POST /browser-extension/embed-content | document.write |
| POST /browser-extension/upload-content | document.write |

### 4b-4 system (`api/system/index.js`, 6)

| Route | Scope | Binding |
|---|---|---|
| GET /v1/system/env-dump | system.env.read | — |
| GET /v1/system | system.read | — |
| GET /v1/system/vector-count | system.read | — |
| POST /v1/system/update-env | system.write | — |
| GET /v1/system/export-chats | chat.export | — |
| DELETE /v1/system/remove-documents | document.delete | — |

`system.env.read` is deliberately its own scope, not `system.read` — env-dump is the highest-value target on the surface and P0-4D(a) is hardening it right now. A key that can read system status must not thereby read env.

`chat.export` is likewise separate from `chat.read`: T-2's security review flagged export as an exfiltration path, so it should be grantable independently.

### 4b-4 openai compat (`api/openai/index.js`, 5)

| Route | Scope |
|---|---|
| GET /v1/openai/models | openai.read |
| POST /v1/openai/chat/completions | chat.write |
| POST /v1/openai/images/generations | openai.generate |
| POST /v1/openai/embeddings | openai.embed |
| GET /v1/openai/vector_stores | workspace.read |

## DoD for each 4b PR

1. Every route in the group registers `validApiKey(scopeFor(METHOD, PATH))` — no literal scope strings at the call site, no `API_KEY_SCOPES.TEMPORARY_ALL` left in the group's files.
2. `EXPECTED_WILDCARD_ROUTES` lowered by exactly the group's count; the sweep test passes without editing the regex (exception: 4b-3 option (a), which edits the regex and says so).
3. A test per group asserting a key **without** the scope gets 403 and **with** it gets 200 — at least one route per distinct scope introduced.
4. Workspace-bound routes: a test that a key bound to workspace A gets 403 on workspace B.
5. Full suite green on real Postgres (§7.0 / §7.2), not the fake.

## §PMO rulings (post 4b-3)
- Naming: grep `server/prisma/seeds/permissions.js` BEFORE proposing any new action. 4b-3 used existing `browser-extension.read/.write` (recon's `extension.*` would have duplicated, R3). 4b-4: `system.env.read`, `system.read`, `system.write`, `chat.export`, `document.delete`, `openai.*` — verify each exists in seed; add only what is missing via slot 043000.
- 4b-3 migration 042000 seeds only `embed.chat.read` + `embed.create`. `embed.chat.read` is separate from `embed.read` (visitor transcripts vs config).
- Bound-key gaps (GET /v1/workspaces list-all, POST /v1/workspace/new mint) → small separate PR after 4b-3, before 4b-4.

## §PMO ruling 4b-4 action names (seed grep on e68fbadf)
Exist: system.read, system.write, chat.write, document.delete, workspace.read, document.bulk_export.
Missing → do NOT create as proposed; map:
- GET /v1/system/env-dump → NEW `system.env.read` (secrets; must not ride on system.read) — slot 043000, super_admin only
- GET /v1/system/export-chats → `document.bulk_export` (existing; matches T-7 D-2: chat.read_others AND bulk_export) — NOT `chat.export`
- DELETE /v1/system/remove-documents → `document.delete` + refuse bound key (403); org-wide grant check lands in T-4b router middleware
- GET /v1/openai/models → `system.read`
- POST /v1/openai/chat/completions → `chat.write`
- POST /v1/openai/images/generations → NEW `image.generate` (V12 will reuse) — slot 043000, super_admin + owner
- POST /v1/openai/embeddings → NEW `embedding.compute` — slot 043000, super_admin + owner/editor
- GET /v1/openai/vector_stores → `workspace.read`
Counter 11→0; after this, PR-4c (#27) at 045000.
