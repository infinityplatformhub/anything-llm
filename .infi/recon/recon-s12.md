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

## The three residuals, now measured (PMO follow-up)

All three came back CLEAN. Recording them as verified rather than assumed, because "probably fine"
is what a later reader inherits otherwise.

**Provider re-link of a suspended user — REFUSED.** Drove `linkPrincipal` against a real
`identity_links` row for a suspended user:

    existing link, suspended user      ->  REFUSED "This account is suspended."
    NEW subject, same email, suspended ->  REFUSED "This email is already linked…"

The second is refused by the R1 anti-takeover rule rather than by the suspension check, which is
worth knowing: the two refusals have different causes, so removing either one leaves a path open.
`linkPrincipal.js:77` is shared by all four drivers (Lark, LDAP, OIDC, SAML) — they reach the same
core, so this is one check rather than four.

**`workspace_users` cascades.** `schema.prisma:251` is a real FK with `onDelete: Cascade`; measured
1 row before the delete, 0 after. `identity_links` likewise (`schema.prisma:409`), 0 after.

So the orphaning in Finding 2 is specific to `principal_role_grants`, and specific to the fact that
its `principal_id` is a String rather than a relation. Every table that models the user with a real
FK behaves correctly. That narrows the fix and is an argument for the schema shape being the defect
rather than `User.delete` being incomplete.

**Mobile device path — closed, in both states.**

    suspended user's device  ->  400 "User is suspended."   next() NOT called
    after the user is deleted ->  device row is GONE (cascade, schema.prisma:546)
    unclaimed device (userId null) -> next() called, locals.user unset

The third line is the one worth flagging: an unclaimed device passes the middleware with no user
attached. That is by design — `endpoints/mobile/middleware/index.js:30` guards the user branch — but
it means every route behind this middleware must handle `locals.user` being absent. Not an
offboarding defect; noted because S12 must not assume this middleware yields a user.

**One more, measured while there: suspension does not remove grants.**

    grants before suspend: 1    after suspend: 1

Consistent with Finding 1 — suspension changes one column and nothing else. Correct today (the
resolver re-reads `suspended`), and it means a suspended user's grants are still live rows that any
`principal_role_grants` query counts. Anything that answers "who holds this role" from the grants
table alone includes suspended users.

## Probe corrections

Two of these probes were wrong before they were right, and both would have produced a false result:

- the first identity-link probe silently failed to create the link (`user_id` vs `userId`), so
  `linkPrincipal` took the NEW-user branch and reported `ALLOWED created=true` — the opposite of the
  truth. It now throws if the setup write fails instead of logging and continuing.
- the first mobile probe passed a request object with no `header()`, so the middleware 500'd on its
  own first line and never reached the suspension check.

Both were caught by the result looking wrong rather than by the probe reporting an error, which is
the argument for asserting on setup rather than on the outcome alone.


---

# Addendum 2 — TL-2 ruling follow-up, measured

Everything below was RUN on a FRESH database (`approof_o5_s12`, migrated and seeded), because the
first attempt at the extension-key probe ran against a worktree DB holding four leftover users and
therefore tested the wrong branch entirely.

## TL-2 (4a) CONFIRMED — a suspended user's API key still authenticates

Driven through the real `validApiKey` middleware, not by reading a column:

    user suspended, key created before suspension
    >>> status: null   next(): CALLED

No status, no refusal, request continues. This is the blocker as TL-2 stated it, and it is the
argument for `revokedAt` being set in the same transaction as `suspended` rather than in a
follow-up job.

## TL-2 (4b) NOT REPRODUCIBLE — the extension-key single-user hole is unreachable today

The claim is that `validBrowserExtensionApiKey.js:27` checks `suspended` only inside
`multiUserMode && …`, so a single-user instance skips it. The check is exactly as described, but
the guard cannot be reached with a suspended user, and the reason is in `isConfirmedSingleUser`
(`actorResolver.js:317`):

    if (await SystemSettings.isMultiUserMode()) return false;
    return (await db.users.count()) === 0;

It requires **zero user rows**. The middleware's local is `!isConfirmedSingleUser()`, so:

    any user row exists   ->  isConfirmedSingleUser() === false
                          ->  multiUserMode === true
                          ->  the suspended check RUNS

and the only way to `multiUserMode === false` is `users == 0`, where there is no user to suspend and
`apiKey.user_id` cannot resolve to one. Measured both ways:

    4 leftover users, setting=false   ->  403, next() not called   (multi-user branch)
    0 users, setting=false            ->  isConfirmedSingleUser() true, but no user to suspend

The orphaned-key variant is closed too: `browser_extension_api_keys.user_id` is a REAL FK, so
deleting the owner takes the key with it — measured, key rows 1 -> 0.

**This is a residual, not a blocker.** The `multiUserMode &&` guard is load-bearing only because
`isConfirmedSingleUser` is stricter than its name suggests; if that helper is ever relaxed to
"exactly one user" — which is what the name implies and what a future reader may well take it to
mean — the hole opens immediately, with no test to catch it. Recommend a test pinning the coupling
rather than a code change, and I would rather state that than remove a guard I cannot demonstrate.

## TL-2's `document_acl` finding CONFIRMED, and it is the same defect as Finding 2

    document_acl before delete: 1  |  after delete: 1  |  inherited by recycled id: 1

`document_acl.principal_id` is a String with no FK (`schema.prisma:880`), exactly like
`principal_role_grants`. A user created at a recycled id inherits the deleted user's document
permissions as well as their roles.

## The full audit of user-referencing columns without a foreign key

Queried from `information_schema` rather than by reading the schema file:

    api_keys.createdBy            model_router_rules.created_by
    document_acl.principal_id     model_routers.created_by
    embed_configs.createdBy       principal_role_grants.granted_by
    event_logs.userId             principal_role_grants.principal_id
    grant_revocations.principal_id  invites.createdBy
    workspaces.created_by

Seventeen other user-referencing columns DO have real FKs and cascade correctly, including
`workspace_users`, `identity_links`, `group_members`, `desktop_mobile_devices`,
`browser_extension_api_keys`, `temporary_auth_tokens`, `recovery_codes` and
`password_reset_tokens`.

Two of these are load-bearing for offboarding — `document_acl.principal_id` and
`principal_role_grants.principal_id` — because they decide authorization. `event_logs.userId` is
TL-2's argument for the terminal state and needs no cleanup by design: an audit row must outlive its
subject.

## What this means for the contract

The `document_acl` half means slice 1 cannot claim to revoke a user's access by clearing grants
alone. Either document ACLs come into scope with the grants, or the contract says plainly that a
suspended user retains document ACL rows and explains why that is safe — which it is today, because
`actorResolver` returns `null` for a suspended user before any ACL is consulted. It stops being safe
the moment anything answers an ACL question without going through the resolver.
