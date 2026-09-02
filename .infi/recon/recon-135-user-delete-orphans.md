# Pre-read — #135: `User.delete` leaves authorization rows behind

Dev 3. **Docs only, no code written.** Read against `53524e57f`
(`approof/134-apply-checkpoint`); everything below is on `main` and unrelated to #134.

---

## 1. What happens today

`models/user.js:315-323`:

```js
delete: async function (clause = {}) {
  try {
    await prisma.users.deleteMany({ where: clause });
    return true;
  } catch (error) {
    console.error(error.message);
    return false;
  }
},
```

Three callers: `endpoints/admin.js:178` (admin deletes a user),
`endpoints/api/admin/index.js:275` (same over the API), `endpoints/system.js:1261`
(`User.delete({})` — every user, during reset).

Prisma cascades clean up everything joined by a **typed FK**: `group_members`,
`workspace_users`, `identity_links`, `recovery_codes`, `workspace_chats`,
`password_reset_tokens`, and ~15 others all declare
`@relation(..., onDelete: Cascade)`.

**They do not clean up the authorization tables, because those do not reference
`users` by FK at all.** Three tables address principals as untyped text:

| table | column | line |
|---|---|---|
| `principal_role_grants` | `principal_id String` | schema.prisma:804 |
| `document_acl` | `principal_id String` | schema.prisma:911 |
| `grant_revocations` | `principal_id String` | schema.prisma:962 |

Plus three nullable audit columns that are `Int?` with no FK: `granted_by`
(schema.prisma:807), `policy_versions.actor_id` (940), `workspaces.created_by` (175).

`principal_id` is TEXT deliberately and correctly — the same column holds
`'core-jobs'`, `'single-user'`, group ids and embed uuids, so it CANNOT be a foreign
key to `users`. That is a sound design decision, and it is exactly why no cascade
exists to inherit. The orphans are a consequence of the design, not a defect in it.

---

## 2. Why this is `auth` tier, not cleanup

Two separate failures. The first is the one that matters.

### 2.1 User ids are RECYCLED, so an orphaned grant is inherited

`users.id` is `autoincrement()`. A sequence does not normally reissue a deleted id —
but `scripts/sqlite-to-pg-import.js:102` does:

```sql
SELECT setval(pg_get_serial_sequence($1, 'id'), value, is_called)
FROM (SELECT COALESCE(MAX("id"), 1) AS value, ... FROM <table>) AS sequence_state
```

The sequence is reset to `MAX(id)` of the imported rows. Delete user 42, import (or
re-import) into that database, and the next user created **is** id 42 — and
`engine.js:200` matches grants by `principal_id: String(grantPrincipal.id)`.

The new person silently inherits every org-wide and workspace-scoped role the deleted
one held, plus every `document_acl` row naming them. Nothing logs it, no grant was
made, and `explainAccess` will correctly report the grant as held — because it is.

**MEASURED, not read.** Probed on a fresh migrated + seeded database
(`s135_probe`), using the real `grantRole`, the real `users.deleteMany` that
`models/user.js` calls, and the real engine:

```
grants held before delete: 1
ORPHANED grants after delete: 1
user row gone: true
successor id: 1 | recycled: true
engine.authorize(successor, "access.diagnose") -> {"allowed":true,"reason":"allowed_by_role"}
```

A user who was granted nothing is authorized `access.diagnose` — `allowed_by_role`,
inherited from a deleted user who happened to hold the same id. That is the whole
tier argument, and it is confirmed end to end rather than inferred.

**One honest limit on the probe:** it calls `setval` itself, so it proves the
CONSEQUENCE (an orphaned grant is honoured for a recycled id) and that the orphan
survives deletion — it does not prove an ordinary deployment reaches a reset sequence
on its own. The known route is `scripts/sqlite-to-pg-import.js:102`, which is a real
supported migration path. Whether any other route exists is still open, and #135
should not claim more than that: the orphan and the inheritance are measured, the
frequency of the trigger is not.

### 2.2 Deletion invalidates no cache

`models/user.js` and both admin endpoints call nothing that bumps `policy_versions` —
grep for `bumpVersion` / `policy_version` in either file returns nothing.

Every membership write goes through `addGroupMember`/`removeGroupMember` precisely so
the bump and the outbox publish happen in one transaction (#113 RF-5, #134 R3). Deleting
a user removes their `group_members` rows by CASCADE — **beneath the repository**, so no
bump happens and no event is published. A `FilterCache` entry built before the delete
keeps naming their workspaces until its TTL expires.

Same shape as the residual #96 left and #113 fixed, arriving through the cascade instead
of through a direct write.

---

## 3. What #135 has to decide (not decided here)

1. **Delete or deactivate?** #134 chose `suspended` for directory-driven departures
   precisely because it is reversible and preserves chats. If admin deletion stays a
   real delete, it needs its own cleanup; if it becomes deactivation, the orphan
   question moves rather than closes — and `validatedRequest.js:114` already 401s a
   suspended user immediately, so the security half is covered either way.
2. **Where does cleanup live?** By symmetry with #113/#134 it belongs in
   `policyRepository` (an `offboardUser` — which is #136's subject, per TL-2), so the
   version bump cannot be forgotten. Doing it in `models/user.js` puts an authorization
   write outside the module that owns authorization writes.
3. **Are the orphans deleted or retained?** `grant_revocations` exists *because*
   revocations must outlive the grants they describe (schema.prisma:955-958). Deleting
   a user's revocation history to tidy up would destroy the audit trail deliberately
   built to survive. My reading: grants and ACLs go, revocations stay, `granted_by` and
   `actor_id` stay (they are audit, already nullable, and naming a deleted actor is
   correct history). Needs a TL ruling.
4. **What about `system.js:1261` (`User.delete({})`)?** It deletes every user during a
   reset. Cleanup keyed per-user id would need a bulk form, or that path leaves the
   whole grant table orphaned at once.

**Overlap warning:** #136 (`offboardUser` in `policyRepository`) and #135 touch the same
seam. If both land independently they will both write user-removal logic. Per the PMO
lane rule, one waits — and #136's `offboardUser` looks like the natural home for #135's
cleanup rather than a parallel implementation.

---

## 4. Evidence contract I would propose

- **A deleted user's grants are gone**: create a user with an org-wide role and a
  `document_acl` row, delete them, assert zero rows in `principal_role_grants` and
  `document_acl` for that `principal_id`. Mutant: skip the grant cleanup.
- **The recycled-id witness, both directions** — the test that makes this `auth`:
  delete user 42 holding `admin`, `setval` the sequence back, create a new user that
  lands on 42, and assert `engine.evaluate` DENIES them the deleted user's permission.
  Paired with a control proving the same engine call ALLOWS it for a user who genuinely
  holds the grant, or the test passes against an engine that denies everything.
- **Deletion bumps the policy version**: build a filter through a live `FilterCache`,
  delete the user, build again through the SAME instance, require the access gone —
  the `groupMembershipPolicyVersion.test.js` pattern, which is already the proven shape
  for this class.
- **Revocation history SURVIVES**: `grant_revocations` rows for the deleted user are
  still present afterwards. This is the paired "leaves X alone" assertion for every
  "X is deleted" test above; without it, a cleanup that truncates by `principal_id`
  passes everything else.

Mutation testing is the bar (§7.9). Note for whoever picks this up: on #134 five mutants
survived the first suite, every one because the fixture never reached the guard it named.
For this issue the trap is the recycled-id test — if the new user does not actually land
on the deleted id, it passes no matter what the cleanup does. Assert the id.

---

## 5. Evidence

- Orphan + recycled-id inheritance: probe output quoted verbatim in §2.1, run against
  a fresh migrated and seeded `s135_probe` using the real `grantRole`, the real
  `prisma.users.deleteMany` from `models/user.js:317`, and the real
  `DatabaseAuthorizationEngine.authorize`.
- `principal_id` is TEXT in all three tables: `schema.prisma:804`, `:911`, `:962`,
  read directly.
- No cascade is possible for them: none declares a `@relation` to `users`.
- The engine matches grants on `String(grantPrincipal.id)`: `engine.js:200`.
- Sequence reset on import: `scripts/sqlite-to-pg-import.js:102`.
- No version bump on deletion: grep for `bumpVersion` / `policy_version` in
  `models/user.js`, `endpoints/admin.js` and `endpoints/api/admin/index.js` returns
  nothing.
- `grant_revocations` is deliberately built to outlive its grants:
  `schema.prisma:955-958`.
