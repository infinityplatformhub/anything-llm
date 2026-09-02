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

---

## Addendum — checked against the new base `9cf7b6fae` (before the final SHA)

**The oracle above still holds.** `git diff 2ba5ca93a 9cf7b6fae` touches
`server/prisma/schema.prisma`, one new migration, and `policyRepository.js`. The migration
is a single unique index:

```sql
CREATE UNIQUE INDEX "groups_orgId_source_externalId_key"
  ON "groups" ("orgId", "source", "externalId");
```

`server/prisma/seed.js` is **unchanged** (`git diff --stat` empty), and nothing in the diff
writes `permissions`, `roles` or `role_permissions`. So the holder table measured on
`qa3_127` is still the right oracle for the final SHA. I will re-measure on the SHA anyway
rather than carry this forward on inference.

### `ORG_CAPS 7 → 11` — the arithmetic checks out, and it is a hard dependency

`ORG_CAPABILITIES` (`server/endpoints/system.js:115`) currently has **7** entries:
`chat.read_others`, `document.bulk_export`, `user.manage`, `settings.write`, `key.manage`,
`access.diagnose`, `workspace.create`.

#121's sidebar needs **8** actions. Four are missing from that list:

| missing | used by |
|---|---|
| `system.write` | llm, vector-database, embedder, text-splitting, image-generation, voice-speech, transcription, model-router, security |
| `system.read` | default-system-prompt, event-logs, mobile-app |
| `user.read` | users |
| `invite.read` | invites |

7 + 4 = **11**, matching the announced repin. This matters for the probe: `useCapabilities`
can only answer `true` for actions the endpoint actually batches, so **without the
`system.js` half, every one of those 13 entries is invisible to `super_admin` too** — not
just to `setup_admin`. A frontend-only SHA would look like a much larger regression than
the permission model implies.

Consequence for my sweep: the exact-visible-set assertions in step (2) are only meaningful
on the **paired** SHA (frontend + `system.js`). If the pair arrives split, I will report the
frontend half's numbers as provisional and say so, rather than record 13 false regressions
against `super_admin`.

### Fixture caveat this creates

A fixture that mocks `useCapabilities` directly (as `e3fbcf775`'s did) bypasses
`ORG_CAPABILITIES` entirely and will answer `true` for actions the real endpoint never
returns. That is the "fixture reaches a sibling, not the gate" failure in its most
expensive form: the suite would stay green through a missing `system.js` change. I will
check whether the new suite mocks the hook or the endpoint, and if it mocks the hook, fire
one case with the real `ORG_CAPABILITIES` list to prove the pairing.

## Addendum — Dev4 independent verification of 6e205d79b (21:55)
Set-intersection by running: ORG_CAPABILITIES (11) ⊇ sidebar asks (8 distinct / 26 entries); MISSING none; dead-in-prod 0/26 (was 13/26 at 7b3063bee). Mutation: delete `system.read` → F-A sidebar-derived test RED reporting [system.read]; literal 11-entry test RED on toEqual + toHaveLength. Extraction regex cross-checked (both forms yield the same 8). Stop on 7b3063bee withdrawn.
