# T-7 plan — delegated admin, view-as-user, revocation audit (#31)

Base `70283c1b`.

## D-4 — `revokeGrant`: permission check + revocation trail

`revokeGrant` refuses a null actor but never asks whether the actor may revoke. Add a
`role.revoke` check (mirroring `grantRole`'s escalation guard), and record the
revocation.

**`revoked_by` cannot be a column on `principal_role_grants`.** Revocation deletes the
row, so a column on it dies with the grant — the audit question is precisely "what used
to be here". Migration `20260902070000` adds a `grant_revocations` table: who revoked,
which principal lost which role in which workspace, when, and the policy version. That
outlives the grant and answers "why can this person no longer do X".

## D-1 — `chat.read_others` becomes per-principal

Delete `chatHistoryViewable` and `DISABLE_VIEW_CHAT_HISTORY`. T-4a already put
`requirePermission("chat.read_others")` behind it at every site, so removal is subtraction,
not substitution. The migration reads the env var **once** to decide the initial grant:
if it was set, nobody starts with `chat.read_others` except `super_admin`.

`systemSettings.js:616` mirrors the env var to the frontend. Replace it with a capability
derived from the engine, or the UI keeps hiding a feature the server now allows.

## D-2 — export requires both

`/system/export-chats` authorizes `document.bulk_export` today. Reading other people's
chats and bulk-extracting them are separately grantable, so the route needs
`chat.read_others` **AND** `document.bulk_export`.

## D-3 — view-as-user write side

Nothing writes `locals.impersonatedBy`; the engine's blanket mutation deny is unreachable
in production. Add the impersonation route and stamp it. Read-only is enforced in T-2 by
construction — the UI must not re-implement it. S-tests go through the real HTTP path; a
unit test that hands `{impersonatedBy}` to `authorize()` proves the engine, not the
feature.

## Duty split

`super_admin` splits into `setup_admin` (install/config/env/keys), `super_admin` (grants +
org), `content_moderator` (other users' chats + exports). Seed edit in
`prisma/seeds/permissions.js` plus a migration that grants the new roles to whoever holds
the old one, so nobody loses access at deploy.

## `utils/helpers/admin/index.js`

8 `ROLES` refs doing role-hierarchy validation (which legacy role a caller may assign).
Becomes a grant question: may this actor grant that role? Uses the engine, not strings.

## Out of scope

`engine.js` and `actorResolver.js` — t4b is rebasing on them. If D-3 turns out to need a
resolver change, stop and ask rather than editing.
