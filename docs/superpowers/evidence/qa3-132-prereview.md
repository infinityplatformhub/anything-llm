# QA-3 — #132 probe prep (SystemReadRoute, Dev4)

Written before the SHA, measured on `5c9ea893d`. Not a plan for Dev4 — the oracle I will
fire the SHA against, plus three things that would be guesses if nobody rules on them.

## What exists today

`frontend/src/components/PrivateRoute/index.jsx` exports exactly two capability guards:

| guard | gate | routes in `main.jsx` |
|---|---|---|
| `AdminRoute` | `can("settings.write") \|\| !multiUserMode` | 26 |
| `ManagerRoute` | `can("user.manage") \|\| !multiUserMode` | 10 |

`SystemReadRoute` does not exist yet (`grep -rn SystemReadRoute frontend/src server` → nothing).

`AdminRoute`'s shape is the template, and three of its properties are load-bearing —
proven by my own mutants on #127:

- `|| !multiUserMode` — G2 killed it. A single-user deployment has no principal.
- `isAuthd === null → FullScreenLoader` — holds the route through most of the async window.
- `multiUserMode && capabilitiesLoading → FullScreenLoader` — **G3 survived**, and the
  source comment says so explicitly: unreachable today because the session check settles
  after the capability map, deliberately untested because reproducing the ordering would
  drive `useIsAuthenticated`'s internals. If #132 copies this line into a new guard, it
  arrives equally untested. **That is acceptable if it is a stated inheritance, not if it
  is presented as covered.**

## The three pages this is presumably for

`system.read` gates three sidebar entries after #121:

| entry | `href` | guard in `main.jsx` today |
|---|---|---|
| Default System Prompt | `paths.settings.defaultSystemPrompt()` | (not a literal path — resolved via `paths`) |
| Event Logs | `paths.settings.logs()` | same |
| Mobile Connections | `/settings/mobile-connections` | **`AdminRoute`** (#127 set this) |

Server side, `requirePermission("system.read", orgResource)` appears **12 times across 5
files**: `system.js` ×7, `mobile/index.js` ×2, `communityHub.js`, `experimental/liveSync.js`,
`utils/foundryUtilsEndpoints.js`.

So the sidebar/route/server sets do not line up: the sidebar gates 3 entries on
`system.read`, the server gates 12 routes on it, and only one page currently uses a guard
that #127 deliberately chose *because no `system.read` guard existed*.

## Rulings I need before the SHA (or the probe measures a guess)

**(a) Which routes move to `SystemReadRoute`?** #127's ledger says the real close for
mobile-connections is "a client guard that asks `system.read` directly" — that is this
issue. But Default System Prompt and Event Logs are gated on `system.read` in the sidebar
while their routes are guarded by something else. If #132 converts only mobile-connections,
the sidebar and the route guard still disagree for the other two. If it converts all three,
that is three behaviour changes, and (b) applies to each.

**(b) `setup_admin` loses these pages entirely.** From my #121 measurement:
`system.read` is held by `super_admin` **only**. `AdminRoute` gates on `settings.write`,
which `setup_admin` **does** hold. So every route moved from `AdminRoute` to
`SystemReadRoute` becomes unreachable for `setup_admin` — including
mobile-connections, which is exactly TL-2's narrowed #127 residual. That is the intended
direction (the server 403s them today), but it is the same class as #121 finding 1 and
should be a stated consequence with the page list, not a discovery. #137 (the seed bug)
may change this; if #137 lands first, `setup_admin` may hold `system.read` and the answer
flips.

**(c) Does `SystemReadRoute` keep `hideUserMenu`?** `AdminRoute` takes it; `ManagerRoute`
does not. A third guard that silently drops it changes chrome on any page that passed it.

## What I will fire

1. **Exit code first** — `yarn test; echo $?`, plus `yarn check:capabilities`. Both are
   exit 0 on `5c9ea893d`; a regression here is the #121/#40-t4 unhandled-rejection class.
2. **Route-table assertions, bounded.** #127's F1 fails open when its delimiter stops
   matching — fixed there by asserting both offsets before slicing. Any new route
   assertion in #132 gets the same P-bleed treatment: route ungated, delimiter broken,
   expected text planted below. It must go red.
3. **The guard itself**: asks `system.read` and not `settings.write` (a mutant swapping
   them must die); `|| !multiUserMode` present (drop it → red); positive control (a holder
   reaches the page) so a guard refusing everyone cannot pass.
4. **Exact reachability per real role** for every converted page, same method as #121:
   `super_admin`, `setup_admin`, `content_moderator`, `member`, single-user. Reported as a
   table whether or not it matches expectations.
5. **The fixture reaches the guard, not a sibling** — one capability at a time, asserting
   the page appears *and* the pages behind the other guards do not.
6. **G3 inheritance**: if the new guard copies `multiUserMode && capabilitiesLoading`, I
   will fire the mutant and report it as surviving-by-design if the comment carries over,
   or as an uncovered line if it does not.

## Note

`5c9ea893d` is not merged yet (held on the user's mockup approval), so #132's base may
move. I will re-measure the holder table on whatever base the SHA sits on rather than
carry these numbers forward.
