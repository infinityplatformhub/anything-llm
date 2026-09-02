# Techlead-1 — #40 task 3 `bbac19502` (plain tier: pre-read is the only pass)

5 files, +388/-6: `useCapabilities.js` (new), `frontend/src/models/system.js`,
`uiBypassStillRefused.test.js` (new), one assertion added to task 2's suite, ledger.
Probes are in-process Node against faithful reproductions of the shipped code (the frontend
has no test runner until #111); no suite run (§7.14).

**Verdict: PASS with two findings.** Neither blocks the merge under the `plain` rule, but
FINDING-1 is a real defect with a one-line fix and should not wait for #111.

---

## REQUIRED RED FIXTURES (answering PMO's three questions)

**RF-1 — deleting a gate must go red at a named test**

Measured: `GATED_ROUTES` is a 9-entry table driven by `test.each`, so the test name is
generated per row. Deleting any single gate goes red at

```
#40 task 3: a principal the UI would have hidden is refused by the server
  › <capability>: <METHOD> <route> is refused
```

with the row's own values substituted — e.g. `user.manage: DELETE /admin/user/9999 is
refused`. That is the right granularity: the failure names the capability and the route, not
"one of nine". The assertion is `status >= 400` **and** `[403,404].includes(status)`, so a
gate deleted such that the route 500s also goes red rather than counting as "refused".

Two suite-guards make this load-bearing rather than vacuous, and both are the ones I would
have asked for:
- `the fixture principal is real and authenticated, not merely unknown` — without it every
  row could be passing because the actor never resolved, which is what a server with **all**
  gates deleted would also do. It asserts the map comes back with exactly `ORG_CAPABILITIES`
  and three specific capabilities are present-and-false.
- `granting the capability flips both the map and the route` — grants super_admin, asserts
  `workspace.create` becomes `true` **and** `POST /workspace/new` returns < 400. Without it
  the suite passes against a server that refuses everything.

**The gap:** the routes are only asserted for the *member* actor. There is no per-row
positive control — the flip test covers `workspace.create` alone. So a gate on, say,
`POST /system/default-system-prompt` that was changed to an *unsatisfiable* condition
(refusing super_admin too) stays green. Lower risk than the reverse, and out of scope for
`plain`, but worth one line in the residual.

**RF-2 — `can()` fail-closed on fetch failure and during loading**

Drove the shipped `fetchMyCapabilities` logic against eight failure shapes:

| response | `can("settings.write")` | `error` |
|---|---|---|
| network throw | **false** | "Failed to fetch" |
| non-JSON body (`json()` throws) | **false** | "Unexpected token <" |
| `200 {}` | **false** | null |
| `200 null` | **false** | null |
| 403 with `{error}` body | **false** | null |
| `{capabilities: null}` | **false** | null |
| `{capabilities: "yes"}` | **false** | null |
| `{capabilities: ["settings.write"]}` | **false** | null |

All false. The two things making that hold are `data?.capabilities ?? {}` (so `can()` indexes
an object rather than throwing) and `=== true` rather than truthiness (so a string, an array,
or an `undefined` all read as denied). The comment at `useCapabilities.js:56-58` states the
second reason correctly.

During loading: initial state is `{capabilities: {}, loading: true}`, so `can()` is false
before the fetch resolves — the safe direction. The hook's docblock is explicit that this is
*not* a usable answer alone and that components must read `loading`. Correct, and the
residual admits nothing proves a component actually does.

**RF-3 — no browser storage**

Confirmed by reading: `useCapabilities.js` has no `localStorage`, `sessionStorage`, or
`indexedDB`; the cache is a module-level promise that dies with the tab. The reasoning
(a revocable grant must not outlive the tab) is written down.

Note for the ledger: the ledger records a static probe that scanned for `localStorage` and
gave a false positive on the **comment explaining why it is not used**, fixed by stripping
comments. That probe is **not in this SHA** — `git ls-tree` shows five files and none is a
probe script; `useCapabilities` is referenced only by itself and the plan doc. So the
"9-item static probe" in the residual is evidence Dev2 ran, not a gate that will re-run. That
is fine for `plain`, but the residual should say *probe run once, not committed* rather than
implying standing coverage.

---

## FINDING-1 — a single failed fetch disables capabilities for the rest of the tab

`loadCapabilities()` (`:16-19`) caches the **promise**, and nothing removes it on rejection:

```js
let capabilitiesPromise = null;
function loadCapabilities() {
  if (!capabilitiesPromise) capabilitiesPromise = System.fetchMyCapabilities();
  return capabilitiesPromise;
}
```

Probed the exact shape — first call rejects, second call is a later component mounting in the
same tab:

```
mount1 rejected: boom
mount2 STILL REJECTED: boom | fetches: 1
cached promise still set? true
```

One transient failure is remembered forever. Every subsequent mount awaits the same rejected
promise, so `can()` stays false for every capability until the user reloads — the UI silently
degrades to "you may do nothing" and stays there after the network recovers.

Two mitigating facts, neither of which closes it:
- `fetchMyCapabilities` catches internally and resolves to `{capabilities: {}, error}`, so
  the promise only rejects if something throws **outside** that catch — e.g.
  `baseHeaders()` reading `window.localStorage` in a context where storage access throws
  (Safari private mode, blocked site data), or an exception in `.then`. Narrow, but real,
  and it is precisely the case with no recovery path.
- The `.then` in the hook has no rejection handler either (`:47`), so the rejection becomes
  an unhandled promise rejection and `setState` never runs — `loading` stays `true` forever.
  A component reading `loading` (which the docblock instructs) renders its skeleton
  permanently. That is arguably worse than rendering denied.

**Fix, one line**, the same shape #96's `groupMembership.js:70` uses for exactly this reason:

```js
if (!capabilitiesPromise) {
  capabilitiesPromise = System.fetchMyCapabilities();
  capabilitiesPromise.catch(() => { capabilitiesPromise = null; });
}
```
and give the hook's `.then` a `.catch(() => live && setState({capabilities: {}, loading: false, error: "unavailable"}))` so `loading` resolves.

`resetCapabilities()` exists but does not help: it is exported and **called from nowhere**
(`grep resetCapabilities frontend/src` → only its own definition). Its docblock says to call
it after a role change, view-as, or sign-out. Task 4 may wire it; today nothing does.

## FINDING-2 — the cache is not cleared on sign-out or on login, and today that is only saved by a full page load

`resetCapabilities` having no callers matters beyond FINDING-1. Traced the auth paths:

- **Sign-out** (`AuthContext.jsx:35-41`, `Modals/Password/index.jsx:60-61`) clears
  `localStorage` and `setStore({user: null})` but does **not** reload the page. The module
  promise survives, so a second user signing in **within the same tab** inherits the first
  user's capability map until something reloads.
- **Sign-in** (`MultiUserAuth.jsx:220-221, 272-273`) does `window.location = paths.home()`,
  which *is* a navigation and does reset module state. So the common path happens to be safe.

So the exposure is: sign out → sign in as someone else **without** the `window.location`
assignment running (the SPA-internal path at `AuthContext.jsx:35-41`), or a view-as-user
session started in-place. The consequence is bounded — a stale map shows menu items the
server then refuses, which is the whole premise of the suite in this SHA — but it shows the
*wrong* user's menu, which is a different and more confusing failure than showing too much of
your own.

Call `resetCapabilities()` from `unsetUser` and from the `!success` branch of `refreshUser`.
Two lines, and it makes the docblock's instruction true rather than aspirational.

## What I am not raising

`useWorkspaceCapabilities` not caching is correct and the reason is written down. Keeping
`visible` separate from `can() === false` is right — a workspace you cannot see and one whose
controls are disabled are different renders. `fetchCanViewChatHistory` keeping its exported
name and `{viewable, error}` shape while delegating is the correct way to avoid touching its
consumers. The added assertion in task 2's suite (`chat.send` must be `true`) closes a real
hole: every other assertion there was satisfied by an all-false map, which is also what a
silently broken lookup returns.
