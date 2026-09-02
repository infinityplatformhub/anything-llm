# ledger — #127 mobile-connections route guard

Branch `approof/127-mobile-guard`, base `e4a0f57ec`. Taken over from Dev1.
TL-2 ruling: `docs/superpowers/evidence/techlead2-127-ruling.md`.

---

## Rulings

Ruling (TL-2, verified independently before acting): fix the CLIENT GUARD, do not widen
`system.read`. Confirmed three ways rather than taken on report:

- the guard — `frontend/src/main.jsx:407` read `<ManagerRoute Component={MobileConnections} />`,
  matching what TL-2 and Dev1 each read at their own SHAs;
- the server gate — both routes the page calls are
  `requirePermission("system.read", orgResource)` (`endpoints/mobile/index.js:21,86`);
- who holds it — measured against the seeded database, not read from a migration:
  `SELECT r.name, r.scope ... WHERE p.action='system.read'` → **`super_admin | org`**, and
  `legacyRoleGrants.js:23` maps `manager → member`, which does not hold it.

So a manager passed `ManagerRoute`, saw the page, and got 403 from both of its calls: a page
that renders and cannot work. Same shape as #108's `AdminRoute` decision. If the ruling were
wrong the cost is that a manager who should have access is redirected — visible, one line to
undo — against the alternative of making the mobile device list, including which user owns
which device, readable by every member of the org.

Ruling: the drift guard lives on the SERVER
(`__tests__/security/systemReadGrantDrift.test.js`), because the frontend cannot hold this
decision. Someone wanting the manager case to "work" could grant `system.read` to `member` and
every frontend test would stay green. Mutation-verified by actually inserting that grant into
the seeded database: 1 failed, then reverted and re-verified green — the revert matters, a
leftover grant would corrupt every later run against this database.

Ruling: the drift test reads the DATABASE, not the migration text. A later migration could add
a grant without touching the file a text scan would read, and the question is what a deployment
actually grants.

## Corrections

Correction 1: my first fixture returned an EMPTY capability map. Since #40 task 4, `AdminRoute`
gates on `can("settings.write")` rather than a role string (`PrivateRoute/index.jsx:104`), so an
empty map refuses everyone — the positive controls failed while looking like guard failures. The
fixture now derives the map from the role under test, so a case that changes the role cannot
silently keep the previous case's capabilities.

Correction 2: `useCapabilities` caches its answer in a MODULE-level promise, so without
`resetCapabilities()` in `beforeEach` every test after the first reused the first one's map — a
manager fixture running on the admin's capabilities. The cache is correct in production (a grant
an admin can revoke must not outlive the tab) and wrong across tests, which is why the hook
exports a reset. Two tests were passing on the wrong map before this was added.

Correction 3: the mock initially lacked `fetchMyCapabilities`, which `UserMenu`'s tree calls on
mount. That does not fail a test — the call sits in an unawaited effect, so it surfaces as an
unhandled rejection while vitest reports the run as passed and exits 1. Same class as the
`getSlashCommandPresets` gap in #40 task 4.

## Why F1 asserts the route table

Every behavioural test in this file proves what `AdminRoute` DOES. None of them prove that THIS
ROUTE uses it — a route left on `ManagerRoute` leaves them all green while the bug ships. So F1
reads the `/settings/mobile-connections` entry in `main.jsx` as source and requires `AdminRoute`
there. Read as text because importing `main.jsx` executes the app entry point and mounts every
page.

This is the same lesson as #124's: an assertion must run where the property it names is the only
thing that could satisfy it. A guard test that never looks at the route table is asserting a
component, not a decision.

## Mutation

| mutant | result |
|---|---|
| route back to `ManagerRoute` | F1 red |
| `system.read` granted to `member` in the database | F7 red |

`multiUserMode: true` is set in every fixture: both guards pass everyone when it is false
(`|| !multiUserMode`), so a fixture without it is green under either guard and proves nothing —
the accidentally-passing-fixture class from #94 and #49.

## Corrections from QA-3

Correction 4: **F1 failed OPEN.** `const routeEnd = block.indexOf("},\n      {")` returns -1
when the delimiter does not match, and `block.slice(0, -1)` is "everything but the last
character" — so a prettier run or a reordered route would silently widen the search to almost
the whole file, find `AdminRoute` in some other route, and pass while THIS route carried no
guard at all. QA-3 reproduced it: guard removed entirely, 6/6 green.

Both offsets are now asserted before slicing. Verified by reproducing the exact P-bleed —
guard removed AND the delimiter broken — which is now red.

This is the #84 class: a text-derived assertion whose extraction step can fail, where the
failure direction is to assert LESS rather than to error. The lesson pairs with #124's: it is
not enough for an assertion to run in a state where only the named property can satisfy it —
the code that BUILDS the assertion's input must fail loudly rather than degrade.

Correction 5: **R2 counted wrong.** `expect(gated).toContain("system.read")` passes when only
one of the two mobile routes is still gated on it, so re-gating `/mobile/devices` to something
weaker while leaving `/mobile/connect-info` alone kept the test green — and `/mobile/devices`
is the half that names which user owns which device. Now asserts a count of exactly 2.
Mutation-verified by re-gating one route only: 1 failed.

## Residuals

### Narrowed, not closed (TL-2 pre-read)

The guard change moves the bug from `manager` to `setup_admin`; it does not eliminate it.
Verified against seeded data rather than taken on report:

```
setup_admin:org -> settings.write        (and NOT system.read)
```

`AdminRoute` gates on `can("settings.write")` since #40 task 4, so a `setup_admin` principal
passes the guard, reaches /settings/mobile-connections, and gets **403 from both routes** — the
same "renders and cannot work" shape, one role narrower.

Not a blocker, for three reasons, all checked: no legacy role string maps to `setup_admin`
(`ORG_ROLE_FOR_LEGACY` is `admin → super_admin`, `manager|default → member`), so reaching this
state requires a deliberate grant; the failure direction is a 403, which refuses rather than
leaks; and the page shows no data before its calls return.

**The real close is a client guard that asks `system.read` directly.** No such guard exists —
`AdminRoute` and `ManagerRoute` are the only two, and neither maps 1:1 onto the permission this
page needs. Building one is its own issue: today the route guards are a coarse two-tier
approximation of a fine-grained permission model, and #127 fits the page to the closest
available tier rather than inventing a third.

### `AdminRoute`'s loading guard is untested (#40 t4)

`PrivateRoute/index.jsx:103` — `if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />` —
survives deletion with every suite green. Its own comment says so and explains why: the
`isAuthd === null` check above holds the route through most of the window, so the line is
reachable only if the session check settles before the capability map. Belongs to #40 task 4,
not to this issue; recorded here because QA-3 found it while reviewing this one.

### `system.read` is coarse

`system.read` is still an ORG-scoped, all-or-nothing permission. A deployment wanting managers
to see mobile devices without seeing everything else `system.read` covers has no way to express
that; the answer would be a narrower action, which is a policy change rather than a guard fix.
Recorded because "managers cannot see this page" is a legitimate thing to want changed, and the
next person should know the shape of the real fix.
