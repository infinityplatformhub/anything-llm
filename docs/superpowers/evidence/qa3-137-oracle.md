# QA-3 — #137 oracle, built before the SHA

Method: copied the clean `qa3_121` seed to `qa3_137` (`createdb -T`), applied
recon-137's proposed grant in SQL on the **copy**, and re-rendered the real
`SettingsSidebar` (tree `5c9ea893d`) with the capability map built from the measured
role→permission rows. Nothing was written to `qa3_121` or to any dev tree.

## 1. The grant, applied and measured

```sql
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r
JOIN permissions p ON p.action IN ('system.write','system.read','user.read')
WHERE r.name='setup_admin' AND r.scope='org'
ON CONFLICT DO NOTHING;          -- INSERT 0 3
```

`setup_admin` goes from 8 org actions to 11: adds `system.read`, `system.write`,
`user.read`. Recon-137 §1 matches what I measured independently.

## 2. Exact visible set for `setup_admin`

| state | entries | count |
|---|---|---|
| **before** | mailer, workspaces, community-hub ×3, interface, branding, chat, embeds, api-keys, system-prompt-variables, browser-extension | **12** |
| **after** | the 12 above **+** llm, vector-database, embedder, text-splitting, image-generation, voice-speech, transcription, model-router, users, Default System Prompt, event-logs, mobile-app | **24** |
| `super_admin` (control) | — | **26** |

**Newly visible: 12 entries.** Still missing versus `super_admin`: `workspace-chats`
(`chat.read_others`) and `invites` (`invite.read`) — neither is in the proposal, and both
are correct to withhold on this issue's framing. (`security` is `hidden` in multi-user for
every role, so 26 is the ceiling, not 27.)

This closes #121 finding 1: of the 14 entries `setup_admin` lost, this grant returns 12.

## 3. **The gap #137 must not leave — Model Router**

`settings.model-router` becomes visible on `system.write`
(`SettingsSidebar/index.jsx:284`), but **every route the page calls is gated on a
different action**:

```
GET  /model-routers            requirePermission("model-router.read")   modelRouter.js:15
GET  /model-routers/:id        requirePermission("model-router.read")   modelRouter.js:29
POST /model-routers/new        requirePermission("model-router.write")  modelRouter.js:52
… 6 more model-router.write routes (74, 92, 112, 138, 162)
```

Measured holders on `qa3_137`: `model-router.read` → `super_admin` only.
`model-router.write` → `super_admin` only.

So after this grant a `setup_admin` **sees the Model Router entry, opens the page, and
gets 403 from its very first list call.** That is exactly the "renders and cannot work"
shape #127 was opened to fix, reintroduced by a grant rather than by a guard.

The sidebar gating this entry on `system.write` is itself the mismatch — it was correct
while `system.write` and `model-router.*` were both super_admin-only, and stops being
correct the moment one of them moves. **Three ways out, and this needs a ruling before the
SHA:**

1. add `model-router.read`/`.write` to the grant (widens beyond the recon's stated set);
2. re-gate the sidebar entry on `model-router.read` (frontend change, contradicts
   recon-137 §6 "the frontend needs no change");
3. accept it and record it, as TL-2 did for the `setup_admin`/`AdminRoute` residual in
   #127.

I have no view on which; I will assert whichever is chosen and report the 403 either way.

## 4. The deny side — bounded, verified

| action | holders on `qa3_137` after the grant |
|---|---|
| `system.env.read` | `super_admin` only ✅ |
| `audit.read` | `super_admin` only ✅ |
| `model-router.read` / `.write` | `super_admin` only (see §3) |

The grant reaches only its three actions — consistent with recon-137 §4 ("the engine has
no wildcards or implications"). I will re-verify this through `engine.authorize` on the
SHA rather than by set arithmetic, which is how the recon produced its own table.

## 5. Mutants I will fire at the migration

**On the migration itself**

| # | mutation | must |
|---|---|---|
| G-a | drop `system.write` from the `IN (...)` list | allow-assertion for `system.write` goes red |
| G-b | drop `system.read` | same for `system.read` |
| G-c | drop `user.read` | same for `user.read` |
| G-d | add `system.env.read` to the list | **deny**-assertion goes red — this is the bounding test |
| G-e | add `audit.read` | deny-assertion goes red |
| **G-f** | **delete the `policy_versions` INSERT** | must go red. Recon-137 says `FilterCache` reads `currentPolicyVersion` every call, so without the bump a running process serves pre-grant decisions until TTL. If nothing goes red, the bump is unverified and the migration ships a cache-staleness bug that only appears under load. |
| **G-g** | **run the migration twice** (`prisma migrate deploy` then replay the SQL) | must stay green and insert 0 rows the second time. `ON CONFLICT DO NOTHING` against `@@id([role_id, permission_id])` is the claim; I will assert row counts before/after, not just absence of an error. |
| G-h | remove the three actions from the **seed literal** but keep the migration | the "fresh DB and migrated DB agree" assertion goes red. Both halves are separate claims and a test that only checks one lets the other drift. |
| G-i | conversely, seed literal only, no migration | same assertion red from the other side |

**On the test that proves it**

- fire each allow/deny through `engine.authorize` with a real grant on a throwaway user
  (the recon's own method), **not** by reading `role_permissions` — a test that queries the
  same table the migration writes is self-satisfying (§7.9f).
- non-vacuity: assert the permission rows exist before asserting nobody over-holds them,
  the way #127's F7 does — otherwise a renamed action passes on zero rows.

## 6. Two things the recon raises that are not mine to settle

- **§3a `user.manage` without `user.read`** — a role that can create, edit and delete users
  but cannot list them. The proposal fixes it by including `user.read`; worth confirming
  that is deliberate scope and not incidental.
- **§7 `DELETE /system/event-logs`** — `setup_admin` would gain the ability to delete an
  audit trail it cannot read (`audit.read` stays super_admin-only). Recon says this cannot
  be excluded without splitting `system.write`. My measurement confirms the asymmetry is
  real; the judgement is PMO's.

## 7. Housekeeping

`qa3_137` is a throwaway copy and can be dropped on your word; `qa3_121` is untouched.
Probe test file deleted, `/tmp/qa3-127` `git status --porcelain` clean. No commits.

---

## 8. Addendum — R5 ruling (`audit.purge` split), measured

PMO ruled §7 by **splitting a new action `audit.purge`, super_admin only**, rather than
accepting the asymmetry. Checked what that ruling has to move, on `qa3_137`:

**`audit.purge` does not exist yet.** `SELECT action FROM permissions WHERE action LIKE 'audit%'`
returns `audit.read` alone. So the ruling is not a re-grant — it adds a permission row, and
the migration must seed it *and* leave it granted to `super_admin` only.

**The route it has to move** (`server/endpoints/system.js:1777`):

```js
app.delete(
  "/system/event-logs",
  [validatedRequest, requirePermission("system.write", orgResource)],   // → audit.purge
```

Note the sibling immediately above it at `:1757` is `app.post("/system/event-logs")` gated
on `system.read` — the *reading* half, which `setup_admin` is meant to gain. So the two
handlers share a path and differ by method, and only the DELETE moves. A mutation that
re-gates the wrong one leaves the same string in the file and passes a careless grep.

### Extra mutants this ruling adds to my list

| # | mutation | must |
|---|---|---|
| A-a | `DELETE /system/event-logs` left on `system.write` (ruling not applied) | red — `setup_admin` must be **denied** the purge |
| A-b | `audit.purge` granted to `setup_admin` in the migration | red — deny-assertion |
| A-c | `audit.purge` row added to `permissions` but granted to **nobody** | must **not** silently pass: `super_admin` must still be allowed it, or the action is dead like `chat.read` was in #63 |
| A-d | re-gate `POST /system/event-logs` (the read) to `audit.purge` by mistake | red — `setup_admin` must still **reach** the log list; this is the shared-path trap |
| A-e | `emitAuditEvent("event_logs_cleared", …)` still fires under the new gate | the audit event on purge must not be lost when the permission changes |

A-c is the #63 lesson restated: a seeded action granted to no role is invisible until
someone needs it. A-d is the one a text-based check would miss.

The rest of §5's list is unchanged. `user.read` confirmed intended per PMO, so §6's first
question is closed; §6's second is superseded by this ruling.
