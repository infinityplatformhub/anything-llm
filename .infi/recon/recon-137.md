# recon-137 — should `setup_admin` be able to finish an installation?

Base: `c23cfb265` (approof/main). Every number below was produced by RUNNING code in
this worktree against a seeded database, not by reading source. Commands are named
so each figure can be re-derived.

## 1. What `setup_admin` actually holds

Read from the database after `prisma/seed.js`, not from the seed literal:

```
setup_admin (8): access.diagnose, key.manage, org.member, role.grant, role.revoke,
                 settings.write, user.manage, workspace.read
```

For scale: `super_admin` holds 62, `content_moderator` 8, `member` 2. The
permission catalog has 62 rows, so `setup_admin` holds 13% of it.

Confirmed through the real engine (`DatabaseAuthorizationEngine.authorize`, a
`setup_admin` grant on a throwaway user, org resource) rather than by set
arithmetic on the seed:

| action | decision | reason |
|---|---|---|
| `settings.write` | **true** | allowed_by_role |
| `user.manage` | **true** | allowed_by_role |
| `key.manage` | **true** | allowed_by_role |
| `access.diagnose` | **true** | allowed_by_role |
| `system.write` | false | no_permission_in_roles |
| `system.read` | false | no_permission_in_roles |
| `user.read` | false | no_permission_in_roles |
| `invite.read` | false | no_permission_in_roles |
| `system.env.read` | false | no_permission_in_roles |

## 2. The route table, measured

`buildRouter()` mounts the real app; walking `app._router` and reading
`handler.handle.action` (the same property `routeGateSweep.test.js` uses) gives
**175 gated routes**. By action, the ones this issue turns on:

- `system.write` — **21 routes**
- `system.read` — **15 routes**
- `user.manage` — 5 routes
- `user.read` — 2 routes
- `invite.read` — 1 route

> **Correction to the brief.** QA-3's "12 `system.read` sites in 5 files" counts
> `requirePermission(...)` CALL SITES in source. The mounted route table has 15,
> and a grep of the same string finds 22 for `system.write` against 21 mounted —
> call sites and routes are not the same number, because one call site can mount
> under more than one path and some appear in code paths that never mount. Every
> figure in this document is from the mounted table.

## 3. The finding: `setup_admin` cannot finish an installation

**`POST /system/update-env` is gated on `system.write`, which `setup_admin` does
not hold.** That is the route the entire LLM / vector-DB / embedder / transcription
preference UI saves through (`frontend/src/models/system.js:292`). So the role
whose name says "set up the system" can open none of the pages that set it up,
and could not save from them if it could.

The full `system.write` set it is refused (21 routes):

```
DELETE /system/credential/:envKey        POST /system/update-env
POST   /system/enable-multi-user         DELETE /system/event-logs
POST   /system/slash-command-presets     POST /system/slash-command-presets/:id
DELETE /system/slash-command-presets/:id POST /system/prompt-variables
PUT    /system/prompt-variables/:id      DELETE /system/prompt-variables/:id
GET    /mailer/settings                  POST /mailer/test
POST   /mailer/settings                  POST /utils/lemonade/download-model
POST   /utils/lemonade/delete-model      POST /agent-skills/whitelist/add
POST   /community-hub/apply              POST /community-hub/import
POST   /community-hub/:type/create       POST /mobile/update/:id
DELETE /mobile/:id
```

and the `system.read` set (15 routes):

```
GET  /system/system-vectors        GET  /system/default-system-prompt
POST /system/custom-models         POST /system/event-logs
GET  /system/slash-command-presets GET  /system/prompt-variables
POST /system/transcribe-audio      POST /utils/foundry/capabilities
GET  /experimental/live-sync/queues GET /community-hub/settings
GET  /community-hub/explore        POST /community-hub/item
GET  /community-hub/items          GET  /mobile/devices
GET  /mobile/connect-info
```

### 3a. A second defect, not in the brief: `user.manage` without `user.read`

`setup_admin` holds `user.manage` (5 routes: create, edit, delete, view-as-user,
list workspaces) and **not** `user.read` (2 routes: `GET /admin/users`,
`GET /system/pfp/:id`).

There is no containment between them in the engine — `heldPermissionIds` matches
exact action ids, so holding the write action grants nothing on the read one.
The result is a role that can create, edit and delete users but **cannot list
them**. #121 gates the Users menu entry on `user.read` (matching `admin.js:67`),
so a `setup_admin` does not see the Users page at all, while `POST
/admin/user/:id` would succeed if it could reach one.

This is the same class of bug as #63 (`chat.read` seeded and granted to nobody)
and should be fixed in the same migration; it is invisible from the brief's
framing because the brief only asks about `system.*`.

## 4. What granting these would newly allow

Adding `system.write` + `system.read` + `user.read` to `setup_admin` newly
permits exactly the 21 + 15 + 2 routes listed above, and nothing else — the
engine has no wildcards or implications, so a grant reaches only its own action.

The three that deserve a decision rather than a nod:

1. **`DELETE /system/credential/:envKey` and `POST /system/update-env`**
   (`system.write`) — these write provider credentials. `updateENV` persists
   secrets and `dumpENV` skips `secret: true` keys, so a holder can SET a
   credential it cannot read back. Still: this is credential-writing authority,
   which is the strongest thing in the set.
2. **`POST /system/enable-multi-user`** (`system.write`) — a one-way transition
   for an instance.
3. **`DELETE /system/event-logs`** (`system.write`) — deleting the audit trail.
   `audit.read` is a SEPARATE action `setup_admin` does not hold, so this grant
   would let it erase logs it cannot read. That asymmetry is worth an explicit
   ruling; the tidier answer is to exclude it, but it comes bundled with
   `system.write` and cannot be split without a new action.

`system.env.read` is NOT proposed and stays super_admin-only: it is the action
that reads raw env values back, and is the one place where "configure the system"
and "read every secret in it" genuinely differ.

## 5. Proposed contract

**Question the issue answers:** yes, `setup_admin` should be able to finish an
installation — that is what the role is for, and today it cannot save a single
provider setting.

**Change:** one migration granting `setup_admin` → `system.write`, `system.read`,
`user.read`, plus the same three added to the seed literal so a fresh database and
an upgraded one agree.

**Migration shape** (following `20260902101000_chat_read_role_grants`, which is
the closest precedent and already idempotent):

```sql
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."action" IN ('system.write', 'system.read', 'user.read')
WHERE r."name" = 'setup_admin' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "policy_versions" ("change_type", "scope_key")
VALUES ('grant', 'org:1');
```

`ON CONFLICT DO NOTHING` against the `@@id([role_id, permission_id])` composite
key makes it idempotent. The `policy_versions` row is NOT optional: `FilterCache`
reads `currentPolicyVersion` on every call, so without it a running process
serves pre-grant decisions until its TTL expires.

**Evidence contract:**

```
cmd:    cd server && npx jest --runInBand __tests__/security/authorization/
expect: Test Suites: 0 failed
```

plus a new test asserting, through the engine and not through set arithmetic:

- `setup_admin` is allowed `system.write`, `system.read`, `user.read` — each
  measured with `engine.authorize`, the way the table in §1 was produced;
- `setup_admin` is still DENIED `system.env.read` and `audit.read`, so the grant
  is bounded and a future widening is a failing test;
- the seed literal and the migration agree — a fresh `prisma migrate deploy` +
  `seed.js` database and a migrated one hold the same set for this role.

**Mutation that must go red:** drop any one action from the migration's `IN (...)`
list and the corresponding allow-assertion fails; add `system.env.read` to the
role and the deny-assertion fails.

## 6. Lane

`server/prisma/seeds/permissions.js` + one new migration directory. Nothing else.
The frontend needs no change: #121 already gates those entries on the capabilities
this grant would make true, which is why those entries appear the moment the grant
lands.

## 7. Open question for the ruling

`DELETE /system/event-logs` (§4.3) — `setup_admin` would gain the ability to
delete an audit trail it has no permission to read. It cannot be excluded without
introducing a new action, so the choice is: accept it, or split `system.write`.
This is a judgement about who is trusted with the audit trail, not a technical
question, so it is not mine to settle.
