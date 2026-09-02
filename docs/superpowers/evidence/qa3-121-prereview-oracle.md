# QA-3 — #121 probe prep: the visibility-regression oracle

Built before the SHA, from the **seeded database** (`qa3_127`, fresh `migrate deploy` +
`seed.js`), not from reading migrations. This is the table I will fire the new SHA
against; PMO asked for "any menu that disappears for a role that held it before".

## Who actually holds each of the eight actions #121 uses

```sql
SELECT p.action, string_agg(r.name||':'||r.scope, ', ')
  FROM permissions p
  LEFT JOIN role_permissions rp ON rp.permission_id = p.id
  LEFT JOIN roles r ON r.id = rp.role_id
 WHERE p.action IN (...)  GROUP BY p.action;
```

| action | holders |
|---|---|
| `system.write` | `super_admin` only |
| `system.read` | `super_admin` only |
| `user.read` | `super_admin` only |
| `invite.read` | `super_admin` only |
| `settings.write` | `setup_admin`, `super_admin` |
| `user.manage` | `setup_admin`, `super_admin` |
| `key.manage` | `setup_admin`, `super_admin` |
| `chat.read_others` | `content_moderator`, `super_admin` |

Org-scope roles in the seed: `super_admin`, `setup_admin`, `content_moderator`, `member`.
`ORG_ROLE_FOR_LEGACY` (`legacyRoleGrants.js:23`) = `admin → super_admin`,
`manager → member`, `default → member`.

## The regressions this predicts

### 1. `manager` loses **every** entry it used to have — expected, and the point of the issue

Seven entries carried `roles: ["admin", "manager"]`: users, workspaces, workspace-chats,
invites, interface, branding, chat, browser-extension. `manager → member`, and `member`
holds **none** of the eight actions. So a legacy manager sees nothing under Admin,
Customization or Tools that it saw before.

This is the intended correction (the server 403s them today), but it is a **large, visible
behaviour change** and it should be a stated consequence in the issue rather than a
discovery after merge. I will assert it, not just note it.

### 2. `setup_admin` **loses 15 entries** that a legacy `admin` could see

`setup_admin` holds `settings.write`, `user.manage`, `key.manage` — but **not**
`system.write`, `system.read`, `user.read`, `invite.read`. So these disappear for it:

llm, vector-database, embedder, text-splitting, image-generation, voice-speech,
transcription, model-router, users, workspace-chats, invites, default-system-prompt,
event-logs, mobile-app, security.

Same shape as TL-2's #127 residual (`setup_admin` passes `AdminRoute` but lacks
`system.read`), one layer up. Whether this is correct depends on what `setup_admin` is
*for* — if it is meant to complete installation, losing `llm`, `embedder` and
`vector-database` makes it unable to do that. **This is the ruling I need from PMO**, and
it is a permission-model question, not a frontend one.

### 3. `content_moderator` **gains** `workspace-chats`

The only entry that becomes visible to a role that could not see it before
(`chat.read_others`). Correct if `content_moderator` is meant to read others' chats — the
action name says yes — but it is a widening, and widenings on an `auth`-tier issue get
asserted explicitly, not assumed.

## What I will fire on the SHA

1. **Exit code first** (`yarn test; echo $?`) — `e3fbcf775` was green-output/exit-1 from
   26 unhandled rejections in the new test file's `@/models/system` mock
   (`fetchSupportEmail`, `fetchCustomFooterIcons`). That must be gone.
2. **The three tables above, per role**, as a fixture sweep: for each of
   `super_admin`/`setup_admin`/`content_moderator`/`member` and single-user, assert the
   exact visible set — not "some entry is visible".
3. **Fixture reaches the gate, not a sibling** (PMO's ask): for each site, hold *only* that
   site's capability and assert that site appears **and its neighbours do not**. A fixture
   granting a capability three entries share proves nothing about which one it reached.
4. **Re-fire the whole `e3fbcf775` mutant set**: M1/M2 (revert each file), M3 (`hidden`),
   M4 (`flex && !user`), M5 (loading guard), and confirm the two that survived —
   **M6** (`capabilities.some` → `.every`, currently dead code: no caller passes the plural
   array) and **M7** (`hasVisibleOptions` passing `hidden: false`, unreachable because the
   fixture pins `viewable: true` with a user set). If the new SHA adds a `capabilities: [...]`
   caller or a `hidden` child case, both become live and must die.
5. `yarn check:capabilities` (was exit 0).

## Note on tier

PMO's latest message calls #121 **auth** tier; the original dispatch called it `plain`.
Taking `auth` — §7.11a says merge waits on my verdict and a Techlead's. Flagging the change
so the ledger records which tier it was contracted at.
