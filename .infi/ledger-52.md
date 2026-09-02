# Ledger — #52 hotfix: impersonated sessions could mutate; setup_admin could grant nothing

Base `3060171c`. Branch `approof/hotfix-impersonation-writes`.

## BLOCKER-1

Ruling: rejected the first ruling (403 on every non-GET from an impersonated session in `validatedRequest`) after Techlead's design check, and confirmed it by measurement: **5 POST routes are gated on read actions** — `POST /system/local-files/by-docpaths` (document.read), `POST /system/custom-models`, `POST /system/event-logs`, `POST /system/transcribe-audio` (system.read), `POST /community-hub/item` (system.read). A method-based guard refuses all five for a view-as-user session the engine would correctly allow. HTTP method is not a proxy for read-vs-write; the ACTION is, and the engine already keys R5 on `READ_ACTIONS`.

Ruling: the fix is to connect the routes that never asked the engine, not to add a second answer beside it. `POST /onboarding` now requires `settings.write` — it writes `onboarding_complete` into `system_settings`, the same thing every other settings route does. `POST /system/enable-multi-user` likewise: it flips the instance into multi-user mode and creates the first admin.

Ruling: `GET /admin/workspaces` re-gated from org-wide `workspace.read` to `user.manage` BEFORE any seeding of `workspace.read`. It lists every workspace and its members, which is user administration. Migration 044000 deliberately removed org-wide `workspace.read` from `member` because the engine reads a NULL-workspace grant as every workspace; leaving an admin route gated on it means the moment any ordinary role legitimately needs `workspace.read`, this route opens with it.

Note: the router sweep (enumerated from `app._router.stack`, every module `index.js` mounts) finds **141** non-GET routes carrying `validatedRequest` and **20** with no `requirePermission`. Not 2, and not the 6 a four-module sweep showed — the count depends entirely on how many modules the sweep loads, which is why it has to enumerate the real router rather than grep source.

## Self-service routes: closed with `requireSelfSession` (PMO ruling)

`POST /system/user` and `POST /web-push/subscribe` are self-service: a user editing their own profile, a user registering their own push endpoint. **No seeded action fits.** `user.write` and `user.manage` are both administrative — `user.write` is held by `super_admin` alone — so gating either route on them breaks the feature for every ordinary user, and `member` holds only `chat.send`. There is no ownership concept in the engine: `evaluate()` never reads `resource.ownerId`.

This is the same gap as **#53** (`org.member` as the "is a real principal" action). Recorded rather than papered over: gating on an admin action would trade a live impersonation hole for a live lockout, and picking `chat.send` as the proxy would put a chat capability in front of a profile edit.

Ruling (PMO): rather than wait for #53, a new middleware `requireSelfSession` refuses these two routes when `locals.impersonatedBy` is set, with reason `impersonated_self_service_denied` and an audit event like an engine denial. This is NOT the method-based guard Techlead rejected: it keys on what the ROUTE means — self-service is acting as yourself, and an impersonated session by definition is not — and is applied route by route rather than to a whole verb.

Ruling: when #53 lands, `requireSelfSession` is REPLACED by the real action, not kept beside it. A second thing that can answer an authorization question is a second thing that can disagree with the engine. Recorded as a residual.

Note: the positive control that matters here is the ORDINARY user editing their own profile. Every alternative fix — `user.write`, `user.manage`, `chat.send` — passes the impersonation tests and fails this one, which is the whole reason the middleware exists rather than a gate.

## MAJOR-2

Ruling: `BASELINE_GRANTABLE = ["chat.send"]` — a constant consulted by the escalation guard, NOT a seed change and NOT a migration. `setup_admin` stays content-free per T-1/T-6. The guard's rule is now `permissions(role) ⊆ permissions(granter) ∪ BASELINE_GRANTABLE`, expressed as set arithmetic rather than a list of role names, so `content_moderator` and `super_admin` are refused by the formula itself rather than by enumeration.

Measured: `setup_admin → member` was refused for exactly one missing permission, `chat.send`. `→ content_moderator` is refused for 6 (chat.read_others and the document actions), `→ super_admin` for 53. Handing over `chat.send` gives away nothing: every member already holds it, so it confers no authority over anyone.

## NIT-1

Ruling: `PRINCIPAL_EXISTS[principalType]` replaced with `ASSIGNABLE_PRINCIPAL_TYPES.includes(...)`. An object literal makes `__proto__` and `constructor` index to inherited members, so a request naming one reaches a non-function and 500s instead of being rejected as a bad principal type.


## REFUSED — seeding `workspace.read` onto `member` (addenda 2 and 4)

Ruling: did NOT seed `workspace.read` onto the org-wide `member` role, and did not move the 4 read routes onto it. The addendum states the four `workspaceBySlug` routes are unaffected. They are not, and this was settled by running it rather than by reading:

```
workspace.read on a workspace they are member of:      allowed=true
workspace.read on a workspace they are NOT a member of: allowed=true
workspace_users rows for this user: 0
```

A fresh database, seeded, `workspace.read` added to `member`, one org-wide member grant, zero memberships — and the engine allows `workspace.read` on a workspace the user has no relationship to. `evaluate()` matches `workspace_id: null` against ANY `resource.workspaceId`, so an org-wide grant covers every workspace and `workspace_users` is never consulted. That is verbatim the vulnerability migration 044000 exists to close ("every ordinary user could read and write every workspace"), caught then by P0-3's regression suite.

Re-gating `GET /admin/workspaces` first (done, addendum 4) removes one symptom and not the cause: the other four routes would still open. The correct fix is #53's `org.member` action — a permission that means "is a real principal of this org" and carries no workspace authority. Escalated rather than executed.

## Sweep test

Ruling: `routeGateSweep.test.js` enumerates `app._router.stack` after mounting every module `index.js` mounts, never greps source. Sweeping four endpoint modules reported 6 ungated routes; the full router reported 20. A grep-based check counts whatever files it happens to open, which is how both holes survived review.

Ruling: the sweep asserts it actually mounted something (>20 registrations, >100 routes, at most one skip). A sweep that silently mounts nothing reports zero ungated routes and passes forever — the §7.9 failure, in the one test whose job is catching omissions.

Ruling: allowlist membership is not enough for the self-service routes — a third test asserts `requireSelfSession` is really in each one's stack. Otherwise removing the middleware leaves the test green, excused by the list that names it. Proved by deleting the middleware: that test, and only that test, goes red.

Ruling: `SINGLE_USER_ONLY_ROUTES` (17) each assert their handler or middleware really checks multi-user mode. `SELF_SERVICE_ROUTES` (2) should empty when #53 lands.

## Evidence

Fresh database, `migrate deploy` from empty, `yarn test` on Node 22:
`Test Suites: 117 passed, 117 total` · `Tests: 1209 passed, 1209 total`
