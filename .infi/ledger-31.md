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

## D-1 done

Ruling: the `DISABLE_VIEW_CHAT_HISTORY` read happens in **Node at boot**, not in the migration. Postgres cannot see the Node process environment — `current_setting('app.disable_view_chat_history', true)` returns NULL whatever the operator set, so a SQL branch on it would silently take the "was not set" path forever, looking like it read the environment while never doing so. Proved with a test that asserts the NULL. Slot `20260902022000` documents the reason and establishes nothing structural; `utils/authorization/chatHistoryMigration.js` does the work, guarded by a `policy_versions` marker written in the same transaction as the change. If wrong, the one-shot belongs in a dedicated migrations-run-once table rather than the policy clock.
Ruling: when the var WAS set, `chat.read_others` is withdrawn from every role except `super_admin`, who can grant it back deliberately — that ability is the entire point of it being a permission. An operator who never set it keeps today's behaviour untouched.
Ruling: dropped the frontend's 24-hour `localStorage` cache of this capability. A flag that only moved when an operator edited the environment could be cached for a day; a grant an admin can revoke at any moment cannot, or the UI keeps offering a feature the server has already begun refusing. Session-only now, failing closed when the request fails. If wrong, the capability endpoint needs its own short TTL rather than none.
Ruling: added `GET /system/my-capabilities` rather than extending `/system/keys`. `keys` answers "what is this instance configured for" and is the wrong shape for "what may this caller do" — reusing it is what made the old flag instance-wide in the first place.

## #40A absorbed into T-7 (PMO ruling)

Ruling: `GET /system/my-capabilities` is the capabilities endpoint #40A planned, so it generalises beyond `chat.read_others` to a fixed `ORG_CAPABILITIES` list. The list is deliberately NOT "every seeded action": an endpoint enumerating the whole vocabulary hands any caller a map of the permission model, and the UI only gates on a handful. If wrong, T-8 needs actions this list omits and adds them explicitly.
Ruling: capabilities are reported present-and-false rather than omitted when denied, so a client can distinguish "denied" from "the server did not answer". Failure returns `{}` — fail closed, offer nothing.
Note: this endpoint gates AFFORDANCES only. Every route re-decides independently, so a stale or forged answer shows a menu item that then refuses. Recorded because a capabilities endpoint invites being mistaken for a gate.

## D-3 done

Ruling: impersonation provenance lives IN the signed JWT (`impersonatedBy` claim), not beside it. A claim the holder could drop would let them upgrade a read-only view-as-user session into a real one — the token is the only part of the session they cannot edit. `validatedRequest` copies it to `locals.impersonatedBy`, which `actorResolver` has read since T-2 while nothing wrote it.
Ruling: read-only is NOT re-enforced in the route or the UI. The engine denies every non-read action for an impersonated actor before any policy lookup (T-2), so a route that forgets is still safe; a second enforcement point could disagree with the first, and then the question is which one is right.
Ruling: an impersonated session cannot impersonate again, and nobody can view as themselves or as a suspended user. Chaining would lose the head of the provenance chain — the second hop would record the first target as the impersonator.
Ruling: the token expires in 30 minutes, against the normal 30 days. This is a support tool, not a login.
Note: the S-tests drive the REAL middleware with the REAL signed token. A test that hands `{impersonatedBy}` to `authorize()` proves the engine, which T-2 already did — it cannot prove the feature exists.
