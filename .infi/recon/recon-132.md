# #132 recon — a client guard that asks `system.read` directly

Read-only. Base `origin/approof/main`. **No decision taken**: two options are costed below for
TL-2 to rule on, per the instruction not to choose unilaterally.

---

## Why this issue exists

#127 fixed `/settings/mobile-connections` by moving it from `ManagerRoute` to `AdminRoute`. That
narrowed the bug rather than closing it. Measured on seeded data:

```
setup_admin:org -> settings.write      (and NOT system.read)
```

`AdminRoute` gates on `can("settings.write")` since #40 task 4, so a `setup_admin` principal
passes the guard, reaches the page, and gets 403 from both of its routes — the same "renders and
cannot work" shape, one role narrower.

The root cause is structural: **the route guards are a coarse two-tier approximation of a
fine-grained permission model.** `AdminRoute` and `ManagerRoute` are the only two, and neither
maps onto `system.read`.

## Hard dependency: #121 must land first

`system.read` is **not** in `ORG_CAPABILITIES` (`endpoints/system.js:115-124` on main —
`chat.read_others`, `document.bulk_export`, `user.manage`, `settings.write`, `key.manage`,
`access.diagnose`, `workspace.create`). Verified on `origin/approof/main` rather than assumed.

So a guard asking `can("system.read")` today receives **false for every caller, including
`super_admin`**, and locks the page out entirely. Any version of this issue that ships before
`system.read` is exposed makes the page unreachable for everyone.

#121 (open) adds it, per PMO. **This issue waits**, and must not add the entry itself — that
would collide in `endpoints/system.js` and duplicate the key-shape and server tests #121 carries.

Tier follows from that: **plain** if #121 has landed and this is guard-only; **auth** if it ends
up touching the server.

## The decision for TL-2

### Option A — a generic `CapabilityRoute action="system.read"`

One guard parameterised by action, replacing the two-tier approximation with the real question.

**Cost.** The component is small — the same body as `AdminRoute` with `can(action)` in place of
`can("settings.write")`. The risk is not the code, it is the invitation: there are **26
`AdminRoute`, 10 `ManagerRoute` and 3 `SingleUserRoute` call sites** in `main.jsx` — counted
three ways with line comments stripped, since a naive grep also matches the guard names inside
comments (the trap from #40 task 4's sweep). TL-2's ruling records 25 + 11; the measured figures
are 26 + 10, which does not change the argument (36 sites either way) but is the number a later
reader will quote. A generic guard makes converting
all 36 look obvious and cheap, and each conversion is a separate authorization decision that
needs its own answer to *"which action does this page actually need?"* — the same question #40
task 4 spent an issue answering for 25 sites, four of which turned out unanswerable.

If #132 ships `CapabilityRoute` and converts only this one route, the repo carries three guards
instead of two and a standing invitation to a 36-site migration nobody has scoped.

**What it buys.** Every future page states its own permission, and the next `#127` does not
happen: there is no "closest available tier" to approximate with.

### Option B — a specific guard for this permission

`SystemReadRoute`, or the page gating itself on `can("system.read")` internally.

**Cost.** A fourth guard that answers exactly one question, and the next distinct permission
needs a fifth. It grows the two-tier problem rather than solving it — but it grows it by one,
visibly, rather than opening a migration.

**What it buys.** The diff is confined to one route and cannot imply anything about the other
36. Reviewable in isolation.

### What I would flag either way

Neither option fixes `setup_admin` **unless the guard is applied to this route**, and neither
prevents the same mismatch elsewhere: the other 35 sites keep whatever approximation they have.
So the residual from #127 closes for this page only, in both options.

The honest framing is that Option A is the better shape and the worse scope, and the choice is
really *"is the 36-site migration something the project wants queued, or something it wants to
avoid implying?"* — which is a planning question, not a technical one, and why it is TL-2's.

## Tests (either option)

- **RED**: a `setup_admin` principal (holds `settings.write`, not `system.read`) is refused
  before the page renders. Fails today — `AdminRoute` admits them.
- `super_admin` still reaches the page. Positive control; without it a guard refusing everyone
  passes the above.
- `multiUserMode: true` in every fixture — both existing guards admit everyone when it is false,
  so a fixture missing it proves nothing (the #94/#49 class).
- `resetCapabilities()` per test — the capability map is cached in a module-level promise, so
  without it every case after the first runs on the first one's map (found in #127).
- The F7 drift test from #127 stays as-is: `system.read` granted only to `super_admin:org`,
  asserted against the database, plus both mobile routes still asking for it.
- **F1-equivalent**: assert the ROUTE TABLE uses the new guard, not merely that the guard works —
  and assert the extraction offsets before slicing, per #127's QA-3 finding, so the check cannot
  fail open.

## Size

Option A: the component, one route conversion, ~6 tests, plus a decision recorded about the
other 35. Option B: the same minus the decision. Neither is large; the scope question is the
whole of the cost.
