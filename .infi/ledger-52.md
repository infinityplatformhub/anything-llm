# Ledger — #52 hotfix: impersonated sessions could mutate; setup_admin could grant nothing

Base `3060171c`. Branch `approof/hotfix-impersonation-writes`.

## BLOCKER-1

Ruling: rejected the first ruling (403 on every non-GET from an impersonated session in `validatedRequest`) after Techlead's design check, and confirmed it by measurement: **5 POST routes are gated on read actions** — `POST /system/local-files/by-docpaths` (document.read), `POST /system/custom-models`, `POST /system/event-logs`, `POST /system/transcribe-audio` (system.read), `POST /community-hub/item` (system.read). A method-based guard refuses all five for a view-as-user session the engine would correctly allow. HTTP method is not a proxy for read-vs-write; the ACTION is, and the engine already keys R5 on `READ_ACTIONS`.

Ruling: the fix is to connect the routes that never asked the engine, not to add a second answer beside it. `POST /onboarding` now requires `settings.write` — it writes `onboarding_complete` into `system_settings`, the same thing every other settings route does. `POST /system/enable-multi-user` likewise: it flips the instance into multi-user mode and creates the first admin.

Ruling: `GET /admin/workspaces` re-gated from org-wide `workspace.read` to `user.manage` BEFORE any seeding of `workspace.read`. It lists every workspace and its members, which is user administration. Migration 044000 deliberately removed org-wide `workspace.read` from `member` because the engine reads a NULL-workspace grant as every workspace; leaving an admin route gated on it means the moment any ordinary role legitimately needs `workspace.read`, this route opens with it.

Note: the router sweep (enumerated from `app._router.stack`, every module `index.js` mounts) finds **141** non-GET routes carrying `validatedRequest` and **20** with no `requirePermission`. Not 2, and not the 6 a four-module sweep showed — the count depends entirely on how many modules the sweep loads, which is why it has to enumerate the real router rather than grep source.

## BLOCKED — needs a ruling before it can be fixed

`POST /system/user` and `POST /web-push/subscribe` are self-service: a user editing their own profile, a user registering their own push endpoint. **No seeded action fits.** `user.write` and `user.manage` are both administrative — `user.write` is held by `super_admin` alone — so gating either route on them breaks the feature for every ordinary user, and `member` holds only `chat.send`. There is no ownership concept in the engine: `evaluate()` never reads `resource.ownerId`.

This is the same gap as **#53** (`org.member` as the "is a real principal" action). Recorded rather than papered over: gating on an admin action would trade a live impersonation hole for a live lockout, and picking `chat.send` as the proxy would put a chat capability in front of a profile edit.

Ruling: `POST /system/user` therefore stays open in this hotfix and its RED test stays RED. A test asserting the hole is closed while it is open would be worse than the hole.

## MAJOR-2

Ruling: `BASELINE_GRANTABLE = ["chat.send"]` — a constant consulted by the escalation guard, NOT a seed change and NOT a migration. `setup_admin` stays content-free per T-1/T-6. The guard's rule is now `permissions(role) ⊆ permissions(granter) ∪ BASELINE_GRANTABLE`, expressed as set arithmetic rather than a list of role names, so `content_moderator` and `super_admin` are refused by the formula itself rather than by enumeration.

Measured: `setup_admin → member` was refused for exactly one missing permission, `chat.send`. `→ content_moderator` is refused for 6 (chat.read_others and the document actions), `→ super_admin` for 53. Handing over `chat.send` gives away nothing: every member already holds it, so it confers no authority over anyone.

## NIT-1

Ruling: `PRINCIPAL_EXISTS[principalType]` replaced with `ASSIGNABLE_PRINCIPAL_TYPES.includes(...)`. An object literal makes `__proto__` and `constructor` index to inherited members, so a request naming one reaches a non-function and 500s instead of being rejected as a bad principal type.
