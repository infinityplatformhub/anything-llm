# QA-3 — #138 `directory.sync` oracle, staged before the SHA

Method as #137: fresh `qa3_138` built by `migrate deploy` + `seed.js` on the **merged #137
tree** (`edd8db6b7`, vocabulary 63), then my reconstruction of the expected migration
applied in SQL. `/tmp/qa3-138-migration.sql` is mine, not Dev3's code.

## 1. The shape applied

```sql
INSERT INTO "permissions" ("action","description","category") VALUES
  ('directory.sync','Directory.sync','directory') ON CONFLICT ("action") DO NOTHING;
INSERT INTO "role_permissions" ("role_id","permission_id")
SELECT r."id", p."id" FROM "permissions" p JOIN "roles" r ON TRUE
WHERE p."action"='directory.sync' AND r."scope"='org' AND r."name"='super_admin'
ON CONFLICT DO NOTHING;
INSERT INTO "policy_versions" ("change_type","scope_key") VALUES ('grant','org:1');
```

## 2. Measured

| assertion | result |
|---|---|
| holders of `directory.sync` | **`super_admin:org`, single row** ✅ |
| `setup_admin` holds it | **no** (0 rows) ✅ |
| vocabulary count | **63 → 64** ✅ |
| `policy_versions` bumped | yes |

**Through `engine.authorize`, with a control** — real users, real role grants:

```
ENGINE setup_admin directory.sync -> false (no_permission_in_roles)
ENGINE setup_admin system.read    -> true  (allowed_by_role)     <- control
ENGINE super_admin directory.sync -> true  (allowed_by_role)
ENGINE super_admin system.read    -> true  (allowed_by_role)
```

The control is the half that matters: the same actor, same resource, a different action,
allowed. So `no_permission_in_roles` is about `directory.sync` specifically, not a probe
that denies everything.

**Probe note:** my first attempt passed `principal:` and a string `resource.id` and got
`missing_actor` for **all four**, control included — a probe that denies everything looks
identical to a correct deny. The signature is `{actor: {type,id,orgId}, resource: {type,id:1}}`
(`setupAdminInstallGrant.test.js:71`). Recording it because a run without the control would
have read as a clean pass.

## 3. G-g idempotency — by row count

Replayed the SQL against the already-migrated database:

| table | before | after |
|---|---|---|
| `role_permissions` | 126 | **126** |
| `permissions` | 64 | **64** |
| `policy_versions` | 13 | 14 (append-only, as in #137) |

## 4. **The #137 F-1 trap is live for #138, and the readers do NOT catch it**

`ALL_ACTIONS` is `super_admin`'s permission set (`SYSTEM_ROLES` → `super_admin.permissions
=== ALL_ACTIONS`, verified). Measured on this tree:

```
ALL_ACTIONS: 63 | directory.sync in vocabulary: false
```

So a migration that creates `directory.sync` **without** adding it to `ALL_ACTIONS` leaves a
fresh, seed-only install with no holder at all — the exact defect TL-1 rejected
`fcf4236d4` for, one action later.

**And the guard that caught it last time does not fire here.** I ran `__tests__/prisma`
against `qa3_138` — a database whose vocabulary is **64** while the seed file says **63**:

```
Tests: 33 passed, 33 total   (exit 0)
```

Both readers are blind to it, for different reasons:

- `t1-authz-migration.test.js` **creates its own database** (`CREATE DATABASE t1_it_…`,
  `:27-49`), so it never sees `qa3_138`. Its `vocabulary table == seed file` test compares
  that private DB against `ALL_ACTIONS`, which agree at 63.
- `vocabulary-diff.test.js` **touches no database at all** — it reads `ALL_ACTIONS` and
  greps source (`:12`, `:81 expect(ALL_ACTIONS.length).toBe(63)`).

So #137's coverage catches *seed-versus-migration disagreement inside a purpose-built
database*, and both readers will go red the moment `ALL_ACTIONS` changes without the pin
being updated — but neither is a check on a real deployed database. That is fine, provided
#138's own suite adds the direction: **assert on a seed-only path that `super_admin`
actually holds `directory.sync`**, the way `setupAdminInstallGrant.test.js` does.

The literal pin `expect(ALL_ACTIONS.length).toBe(63)` must become **64** in the same commit;
a commit that adds the action without touching it fails, and one that touches it without
adding the action fails t1. Both directions already held — same as #137.

## 5. Mutants for the SHA (G-a…G-j, A-c reused)

| # | mutation | must |
|---|---|---|
| G-a | drop `directory.sync` from the permissions INSERT | allow-assertion for `super_admin` red |
| G-d | also grant it to `setup_admin` | deny-assertion red |
| G-e | grant it to `member` | deny-assertion red |
| G-f | delete the `policy_versions` INSERT | the bump assertion red (`FilterCache` staleness) |
| G-g | run the migration twice | green, `role_permissions`/`permissions` unchanged by count |
| G-h | omit `directory.sync` from `ALL_ACTIONS` (**the F-1 trap**) | **must red** — and if the only failure is the `63`/`64` literal, the suite is pinning a number, not proving a holder |
| G-i | seed lists it, migration creates nothing | migration-alone assertion red |
| G-j | `migrate deploy` on a DB already at the previous migration | picks the new one up |
| A-c | permission row created, granted to **nobody** | red — `super_admin` must be allowed it (#63) |

G-h is the one I will fire first and report loudest: on `fcf4236d4` its equivalent shipped.

## 6. Housekeeping

`qa3_138` is a throwaway; `qa3_121` and `qa3_137` untouched. No files written to any dev
tree. No commits.
