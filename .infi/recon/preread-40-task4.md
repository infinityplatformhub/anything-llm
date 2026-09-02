# Pre-read — #40 task 4: site → capability mapping

For Dev2's issue. Read-only; nothing changed. Tasks 1-3 are in the tree
(`endpoints/system.js` `/system/my-capabilities`, `frontend/src/hooks/useCapabilities.js`).

---

## The count is 25 sites, not ~19

`grep -rnE 'role ===? *"(admin|manager|default)"|role !== *"(admin|manager|default)"' frontend/src`
returns **25** non-test matches. #40's recon estimated ~19 in ~14 files; it was written before
several of these existed. Scoping from the issue's number will under-plan by about a quarter.

## Four sites CANNOT convert, and that is the headline

`can(action)` answers **"may I?"** — it is a question about the caller. Four of the 25 ask about
somebody ELSE's role, and no capability endpoint can answer them because the question is not
about the session actor at all:

| site | reads | why it cannot convert |
|---|---|---|
| `Members/AddMemberModal:65` | `user.role !== "admin"` over the user LIST | filters which OTHER users may be added |
| `Members/AddMemberModal:66` | `user.role !== "manager"` over the same list | same |
| `Admin/Users/index.jsx:148` | `role` passed as a PROP to `MessageLimitInput` | the role of the user being EDITED |
| `Admin/Users/.../EditUserModal:106` + `NewUserModal:90` | `currentUser?.role === "admin"` gating an `<option value="admin">` | the caller's — see below |

The last row is subtler and worth care. It IS about the caller, so it looks convertible — but
what it gates is *"may I grant the admin role to someone"*, and the nearest capability is
`user.manage`, which is not the same question: `user.manage` covers editing users at all.
Converting it to `can("user.manage")` would show the "Administrator" option to anyone who can
edit users, which is a widening, not a translation.

**Recommendation:** those four stay on role strings for task 4, with a comment saying why, and
the DoD's grep (§5) gets an allowlist rather than an expectation of zero. A grep that must
return empty will otherwise push whoever finishes this into converting them incorrectly to make
the check pass — the gate would then certify a widening as done.

If the project wants them converted properly, that is a server change first: an action like
`role.grant` (which exists in the actions table — `migration.sql:266`) exposed through the
capabilities endpoint. That is its own issue, not task 4.

## The 21 that do convert

Grouped by what they actually gate, with the capability that matches:

**Whole-page / settings gates → `settings.write`**
- `SettingsButton/index.jsx:11`, `SettingsSidebar/index.jsx:118,169`
- `PrivateRoute/index.jsx:89` (AdminRoute), `:118` (ManagerRoute)

**Workspace visibility → `workspace.read` (per workspace) or `workspace.create` (org)**
- `Sidebar/index.jsx:161,193`, `Sidebar/SearchBox:192`, `Sidebar/ActiveWorkspaces:167`
- `Modals/ManageWorkspace:83,140`

This group is where #40's real bug lives: a `default` user holding a workspace `editor` grant is
hidden from the sidebar today although the engine authorizes them. The workspace half of the
endpoint answers this per workspace, so the conversion fixes it rather than merely restating it.

**Document/embedding controls → `document.create`**
- `DnDWrapper/FileUploadWarningModal:28`, `PromptInput/AttachItem/ParsedFilesMenu:23`

**Workspace configuration → `workspace.write`**
- `WorkspaceModelPicker:96`, `PromptInput/LLMSelector/action.jsx:92`
- `WorkspaceSettings/AgentConfig:88`, `PromptInput/ToolsMenu:26`
- `ChatSettingsMenu/Memories:14`, `MemoriesSidebar/MemoriesContext:25`

**Shortcuts → `settings.write`**
- `utils/keyboardShortcuts.js:129`

## Three traps in the conversion itself

**1. `!user` means single-user mode, and every site handles it.** Eleven of the 25 read
`!user || user.role !== "default"` or similar — the `!user` branch is "no multi-user, allow".
`can()` returns **false while loading**, which is the same value as denied (the hook's own
docblock says so). A naive swap turns "single-user, allowed" into "hidden until the fetch
resolves", so every converted site needs the `loading` branch the hook documents, not just
`can()`.

**2. `PrivateRoute`'s `|| !multiUserMode` is DoD item 6 and is load-bearing.** Removing it
without replacing the single-user path locks a single-user operator out of their own instance.
It is the same bypass shape T-4a removed server-side, but here it is correct — single-user mode
has one operator. Keep it with the comment the DoD asks for.

**3. Workspace capabilities are per workspace.** `WORKSPACE_CAPABILITIES` is answered for a
named workspace. Sites inside a workspace view have one in scope; `Sidebar/index.jsx:193` gates
the sidebar as a whole and does not. Whoever converts it needs to decide what "may see the
sidebar" means — most likely "has any workspace", which is a different query from any single
capability and may need the endpoint to answer a list.

## Suggested RF list

- **RF-1** a `default` user with a workspace `editor` grant SEES the sidebar. #40's stated real
  bug; RED today.
- **RF-2** an actor holding `chat.read_others` WITHOUT `role === "admin"` sees the control it
  gates. T-7's shape (#31), asserted before it lands so the UI is not rebuilt then.
- **RF-3** single-user mode (`!user`) still sees everything, and does NOT flash hidden while
  capabilities load — the `loading` trap above, which a `can()`-only conversion fails.
- **RF-4** the four non-convertible sites still gate on role, and the DoD grep allowlists them
  with a reason. Mutation: converting `EditUserModal:106` to `can("user.manage")` must FAIL —
  it is a widening, and a test that permits it certifies the bug.
- **RF-5** a capability fetch FAILURE hides rather than reveals (the hook drops a rejected
  promise so the next reader retries; the direction on failure must be closed).
- **RF-6** positive control: an admin sees every converted affordance. Without it a conversion
  that hides everything passes RF-1..5.

## Size

21 conversions across ~18 files, plus the four documented exceptions. The endpoint and hook
exist, so this is UI work — but it is not mechanical: three of the four groups above need a
judgement about which capability is the right question, and `Sidebar:193` needs one that no
single capability answers.
