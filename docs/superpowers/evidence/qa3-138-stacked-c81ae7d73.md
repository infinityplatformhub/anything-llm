# QA-3 — `approof/138-stacked` `c81ae7d73` pin-64 + holder + both-shape — PASS (written by PMO from QA-3 body)

Read-only, fresh DBs qa3_stkA/B.

**Vocabulary/pin:** vocabulary-diff.test.js:90 `toBe(64)`; ALL_ACTIONS 64 with audit.purge and directory.sync both present; migrations 20260902140000 + 20260902150000 present. Resolved by adding both, not choosing.

**Rows (both shapes identical):**
```
audit.purge    | audit     | any
directory.sync | directory | org
org.member     | org       | org
```
64 rows each; sorted tuple diff empty; category='' 0; scope null/'' 0.

**Holders (both shapes):** audit.purge ← super_admin; directory.sync ← super_admin; setup_admin holds system.read, system.write, user.read and NOT audit.purge/directory.sync.

**Mutants:** pin 64→63 RED (1); remove audit.purge from ALL_ACTIONS RED 5 (incl. RF-F2b holder); remove directory.sync RED 7 (incl. B HOLDER). Both directions hold a holder assertion; no slice relies on the pin alone.

**Suites:** directorySyncPermission + setupAdminInstallGrant 35/35; `__tests__/prisma` 5 suites 33/33. routeGateSweep not run (queue half, out of scope).
