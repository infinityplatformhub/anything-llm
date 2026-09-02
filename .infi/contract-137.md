# Contract — #137: `setup_admin` can finish an installation

Dev 1. Written on recon `27bd6b9f5` (`.infi/recon/recon-137.md`, on main). Every
figure below was measured in that recon by running code, not by reading source.

**Tier: auth.** This grants permissions to a seeded role. Full QA + Techlead
verdict before merge.

**BLOCKED ON ONE RULING — see R5.** No code until TL-1 answers it. R5 changes
which actions the migration grants, so writing the migration first would mean
writing it twice.

---

## R1. What is wrong

`setup_admin` holds 8 of 62 permissions and NOT `system.write`, so
`POST /system/update-env` refuses it. That is the route every provider settings
page saves through (`frontend/src/models/system.js:292`). The role named for
setting the system up cannot save a single setting.

Measured through `DatabaseAuthorizationEngine.authorize` with a real grant:

| action | today |
|---|---|
| `settings.write`, `user.manage`, `key.manage`, `access.diagnose` | allowed_by_role |
| `system.write`, `system.read`, `user.read`, `invite.read`, `system.env.read` | no_permission_in_roles |

It is refused 21 `system.write` routes and 15 `system.read` routes.

## R2. Second defect, fixed in the same migration

`setup_admin` holds `user.manage` (5 routes) and NOT `user.read` (2 routes:
`GET /admin/users`, `GET /system/pfp/:id`). `heldPermissionIds` matches exact
action ids with no implication between them, so the role can create, edit and
delete users but cannot list them.

Same class as #63 (`chat.read` seeded, granted to nobody). It is one INSERT away
and belongs here rather than in a follow-up.

## R3. Deliverable

One migration plus the matching seed change. Nothing else — the frontend needs no
edit, which R4 proves rather than assumes.

**Migration**, following `20260902101000_chat_read_role_grants`:

```sql
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON p."action" IN (<actions from R5>)
WHERE r."name" = 'setup_admin' AND r."scope" = 'org'
ON CONFLICT DO NOTHING;

INSERT INTO "policy_versions" ("change_type", "scope_key")
VALUES ('grant', 'org:1');
```

Two properties, neither optional:

- **Idempotent.** `ON CONFLICT DO NOTHING` against the
  `@@id([role_id, permission_id])` composite key. Re-running the migration on a
  database that already has the rows must be a no-op, not an error.
- **The `policy_versions` bump.** `FilterCache.get` reads `currentPolicyVersion`
  on every call (`utils/authorization/cache.js`). Without this row a running
  process serves pre-grant decisions until its TTL expires — the grant would
  appear to work on a fresh boot and not on a live one, which is the worst
  version of this bug to debug.

**Seed** (`prisma/seeds/permissions.js`, `SYSTEM_ROLES` → `setup_admin`): the same
actions added to the literal, so a fresh database and an upgraded one agree.

## R4. Tests

**A. The grant works — through the engine, not set arithmetic on the seed.**
For each granted action, `engine.authorize({actor: <setup_admin grantee>, action,
resource: orgResource})` is `allowed: true`. Constructed the way the recon did:
create a user, grant the seeded `setup_admin` role, ask the real engine.

Asserting the seed array contains the string would pass with the migration
deleted and the engine broken. It has to be a decision.

**B. The grant is BOUNDED — the deny half.**
`system.env.read` and `audit.read` must stay `allowed: false` for `setup_admin`.
Without these, widening the grant later is a silent change; with them it is a
failing test. `system.env.read` is the action that reads raw env values back and
is the one place "configure the system" and "read every secret in it" genuinely
differ.

**C. Seed and migration agree.**
A database built by `prisma migrate deploy` + `seed.js` and one built by
migrations alone hold the same permission set for `setup_admin`. This is what
catches the seed being updated and the migration forgotten, or the reverse — a
split that only shows up on a fresh install months later.

**D. RF — the #121 sidebar shows the restored entries, with no frontend change.**

Measured through the REAL `/system/my-capabilities` response, not a mocked
`useCapabilities`: as a `setup_admin`, `GET /system/my-capabilities` answers
`system.read: true`, `system.write: true`, `user.read: true`.

This is the assertion that proves no frontend work is needed. A client-side test
with a mocked hook would prove only that the sidebar reads a map — the #121
lesson, where exactly that mocking hid four capabilities missing from
`ORG_CAPABILITIES` on the server.

> **Dependency, stated because it is load-bearing:** this RF requires
> `ORG_CAPABILITIES` to contain `system.read`, `system.write` and `user.read`.
> Those are added by **#121** (`7960ceac1`), which as of main `377bd379a` is NOT
> merged — main still has the 7-entry list. Until #121 lands, D fails for a reason
> that has nothing to do with this issue. Either #137 merges after #121, or D is
> written to skip with an explicit message naming the dependency. It must not be
> written to pass in both worlds; that would make it decorative.

**Mutations that must go red:**

| mutation | expected |
|---|---|
| drop any one action from the migration's `IN (...)` | its allow-assertion in A fails |
| add `system.env.read` to the role | deny-assertion in B fails |
| update the seed literal but not the migration | C fails |
| revert #121's `ORG_CAPABILITIES` additions | D fails (or skips, per the note above) |

## R5. THE OPEN RULING — do not start until this is answered

`DELETE /system/event-logs` is gated on `system.write`. Granting `system.write`
therefore lets `setup_admin` **delete an audit trail it has no permission to
read** — `audit.read` is a separate action it does not hold and this contract
does not grant.

It cannot be excluded without splitting `system.write` into a new action, because
the gate is shared with the 20 other routes the role legitimately needs.

Three answers, each changing the deliverable:

1. **Accept it.** Grant `system.write` as-is. The migration grants
   `system.write`, `system.read`, `user.read`. Simplest, and the contract above
   is complete as written.
2. **Split the action.** A new `audit.purge` (or similar) for
   `DELETE /system/event-logs`, held by `super_admin` only. Adds a permission row,
   a route change and a migration — larger, and it touches a file outside the
   stated lane.
3. **Grant `audit.read` too**, so the role can at least read what it can delete.
   Removes the asymmetry without new actions, but widens the grant to the audit
   trail, which is a bigger trust decision than the one this issue set out to make.

This is a judgement about who is trusted with the audit trail, not a technical
question, so it is not the dev's to settle.

## Evidence contract

```
cmd:    cd server && npx jest --runInBand __tests__/security/authorization/
expect: Test Suites: 0 failed
```

Plus the new suite's own line, and — because a passing summary is not a passing
run — `; echo $?` must be `0`. That is §7.17 and it has already cost this project
one review round on #121.

## Lane

`server/prisma/seeds/permissions.js` + one new migration directory + one new test
file. Nothing else. Answer 2 of R5 would add `server/endpoints/system.js` and a
permission row, which is why R5 gates the start rather than being resolved during
implementation.
