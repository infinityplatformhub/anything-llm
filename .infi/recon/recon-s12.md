# S12 — offboarding: recon

Recon only. No code written, no contract yet. Every claim below was RUN on
`4efcf0a89`, not read.

Lane checked before starting: `policyRepository.js` is Dev3's (S4b) — this recon **reads** it and
proposes no edit to it. `redaction.js` is finished (#131 merged). No overlap.

## What exists today

Offboarding is not a feature. It is three unrelated mechanisms that each do part of the job and
never refer to one another:

| mechanism | where | what it actually does |
|---|---|---|
| `suspended` flag | `users.suspended Int @default(0)` | read at 9 call sites, written by ONE generic route |
| `removeGroupMember` | `policyRepository.js:657` | bumps `group_membership` policy version in the same tx |
| user delete | `models/user.js:315` | `prisma.users.deleteMany` and nothing else |

**`removeGroupMember` has no production caller.** Measured: the only references outside its own
definition are in `__tests__/security/identity/groupMembershipPolicyVersion.test.js` (12 of them).
It is a correct, tested function that no endpoint reaches — which is what "first real caller" in the
brief means, and it is the safest of the three to build on because its transaction semantics are
already proven.

**`suspended` has no dedicated route.** It is written only through `POST /admin/user/:id`
(`endpoints/admin.js:118`), the generic user-update endpoint, as one field among many in
`reqBody(request)`. `User.update` casts it (`models/user.js:83`) and writes it. There is no
"suspend user" action, no audit event distinct from a profile edit, and no separate permission —
suspending someone and renaming them are the same call with the same `user.manage` check.

## Finding 1 — suspension does not bump the policy version

    policy version before suspend: 13
    policy version after  suspend: 13     BUMPED: false

`User.update` contains no reference to `bumpVersion`, `policy`, or the repository at all. Every
membership mutation in `policyRepository` bumps a version in its transaction precisely so cached
decisions are invalidated; suspension is the one state change that revokes *everything* and it
bumps nothing.

What saves it today is that `actorResolver.js:128,203` re-reads `suspended` per request and returns
`null`, and `validatedRequest.js:114` 401s before that. So the live path is closed. The exposure is
any consumer that trusts the version as a cache key — the version says "nothing changed" while the
user's entire authorization changed.

## Finding 2 — deleting a user ORPHANS their grants, and a recycled id inherits them

    grants before delete: 1        group_member rows: 1
    ORPHANED grants after: 1       group_members after: 0

`group_members` cascades (real FK). `principal_role_grants` does not: `principal_id` is a **String**
with no foreign key to `users` (`schema.prisma:800-812`), and `User.delete` is a bare `deleteMany`
on `users`. The grant row survives its principal.

That is a leak rather than only untidiness, and it was measured rather than reasoned:

    admin user id 2, role_id 1 grant
    delete user 2
    INSERT a NEW user at id 2
    REUSED id 2 inherits grants: 1  role_ids: 1

A user created at a recycled id inherits the deleted admin's grant. Postgres does not reuse
`SERIAL` ids on its own, so this needs an explicit id — a restore, a seed, an import, a migration
that renumbers. Those are exactly the operations run during an incident, and the result is silent
privilege inheritance with no log line anywhere.

`grant_revocations` (`schema.prisma:927`) already exists and is also keyed by `principal_id`, so
whatever S12 does must decide what a revocation row means for a principal that no longer exists.

## Finding 3 — credentials outlive their owner in both directions

`api_keys.createdBy` is `Int?` with **no relation** to `users` (`schema.prisma:10-28`): it is not a
foreign key, so deleting the creator neither cascades nor nulls it. `validApiKey.js:28`'s own
comment says a key's authority is `grants(createdBy) ∩ scopes(key)` — and Finding 2 shows
`grants(createdBy)` survives the delete. The two findings compose: **delete an admin, and a key they
minted keeps resolving against the orphaned grant.**

`validBrowserExtensionApiKey.js:27` checks `suspended` only inside `multiUserMode && …` — its own
comment flags this. `temporary_auth_tokens` checks it (`models/temporaryAuthToken.js:84`).
`desktop_mobile_devices` checks it (`endpoints/mobile/middleware/index.js:33,86`).

**JWTs cannot be revoked at all.** `makeJWT` (`utils/http/index.js:25`) signs with a **30-day**
default expiry and there is no session table, no denylist, and no `jti`. Suspension works only
because `validatedRequest` re-reads the user on every request. Any future path that trusts a token
without that lookup has a 30-day window, and nothing in the schema could close it.

## What S12 has to decide

1. **Is suspension a policy event?** If yes it bumps a version and needs its own scope key; if no,
   that has to be written down, because every neighbouring mutation does bump one.
2. **Delete vs. deactivate.** Deleting orphans grants (Finding 2). Either `User.delete` becomes
   transactional and clears `principal_role_grants` + `grant_revocations`, or delete is disallowed
   in favour of a terminal state. This touches `policyRepository`'s table — **Dev3's lane** — so it
   needs PMO sequencing, not a unilateral edit.
3. **Does offboarding get its own action?** Today `user.manage` covers rename and suspend equally.
   A `user.offboard` action would let the two be granted separately; it is also a new permission row
   and a migration.
4. **Key revocation on offboard.** `api_keys.revokedAt` exists and nothing sets it during
   offboarding.
5. **`removeGroupMember`'s first caller** — the brief's actual subject. It is ready; what is missing
   is the endpoint, its permission, and whether removal from the LAST group implies anything.

## Suggested shape, for the contract discussion

An `offboardUser` operation in ONE transaction: set `suspended`, delete `group_members`, delete
`principal_role_grants` for the principal, set `revokedAt` on keys they created, bump the policy
version once — with the delete-vs-deactivate question (2) settled first, because it decides whether
this is additive or replaces `User.delete`.

Risk tier: this is `auth` on every axis — permissions, schema, session revocation.

## What I did NOT verify

- whether any Lark/LDAP/OIDC/SAML provider path re-links a suspended user on next login
  (`linkPrincipal.js:77` throws for an existing link, but I did not drive a real login)
- whether `workspace_users` rows for a deleted user cascade
- the mobile device path end to end
