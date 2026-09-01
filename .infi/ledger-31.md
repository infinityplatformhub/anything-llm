# Ledger — #31 T-7 admin duties

Base `70283c1b`. Branch `approof/t7-admin-duties`. DB `approofworkspace_t7`. Migration slot **20260902021000**.

## What T-4a already did, so T-7 does not redo it

- `chatHistoryViewable` usages already sit *behind* `requirePermission` at all 3 sites (`system.js:1200`, `:1244`, `embedManagement.js:98`). T-7 deletes the middleware and env var; the permission gates are in place.
- `/system/workspace-chats` already requires `chat.read_others`; `/system/export-chats` already requires `document.bulk_export`. D-2's remaining half is the **AND** — export needs both.
- `revokeGrant` already has `requireActor` (added by T-3's security round). What is missing is the `role.revoke` **permission** check and the revocation audit trail.

## Open question recorded before work starts

`revoked_by` cannot be a column on `principal_role_grants`: `revokeGrant` DELETEs the row, so any column on it is gone with the grant. A revocation record needs somewhere that outlives the grant. Options are a `grant_revocations` audit table or soft-delete on the grant. Deciding in favour of the audit table below.

## D-4 done

Ruling: revocation history lives in a `grant_revocations` table (migration 20260902021000), not a `revoked_by` column. `revokeGrant` deletes the grant row, so a column on it is destroyed by the act it exists to record. Soft-delete was rejected: every grant query would then carry `WHERE revoked_at IS NULL` forever, and one omission silently restores revoked access. PMO approved. If wrong, the table needs pruning policy the grant row would have gotten for free.
Ruling: `role_name` is denormalised into the revocation row and there is deliberately NO foreign key to `roles`. A role renamed or deleted later must not erase the history of grants that carried it — the auditor needs the name as it was at revocation time. If wrong, a rename makes old revocation rows disagree with current role names.
Ruling: the audit row is written in the SAME transaction as the delete and the version bump. An audit log that can lose a row while the deletion commits is worse than none — it looks complete when it is not. Proved by a test asserting a refused revocation leaves no row AND does not move the policy clock.
Ruling: `isExemptPrincipal` continues to cover `singleUser`/`coreJobs`, so `legacyRoleGrants`' demotion path keeps working without holding `role.revoke`. If wrong, user demotion breaks the moment the exemption is narrowed.
Note: index names in the migration must match Prisma's generated convention (`grant_revocations_principal_type_principal_id_revoked_at_idx`), or `migrate diff` reports drift on every later migration. Caught by running the diff, not by reading.
