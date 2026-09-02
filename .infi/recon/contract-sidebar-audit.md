# Contract — sidebar entry ↔ route action audit

TL-2 ruling **998f4438a**. Base `origin/approof/main`. **Docs only; issue not opened.**
Supersedes the scope section of `recon-sidebar-audit.md`; the recon's measurements stand except
where corrected below.

Re-measured after TL-2's (c) correction. Harnesses rerun, not re-read:
```
node .infi/recon/sidebar-audit-router.cjs    # 318 routes, 174 with requirePermission
node .infi/recon/sidebar-audit-resolve.cjs   # entry -> href -> route -> page
node .infi/recon/sidebar-audit-calls.cjs     # page -> calls -> mounted actions
node .infi/recon/sidebar-audit-inhandler.cjs # gates inside handler bodies
```

---

## (a) The rule

**A sidebar entry and its route guard name the same READ action. Write controls inside the page
gate on the write action** (the #121 R4 pattern).

Rationale, in one line: a guard answers *may this principal open the page*, which is a read
question; whether they may change anything is a second question the page itself asks. Gating the
route on the write action hides pages people may legitimately read; gating it on the read action
and leaving write controls ungated is the #127 defect in reverse. Both halves are needed.

TL-2 measured that this widens no role on the default seed. **Not re-verified here** — it needs
seeded data, and this contract is docs-only. Flagged as an assumption the implementing dev must
confirm by running, not inherit from this document.

## (b) Guard mechanics

`AdminRoute` / `ManagerRoute` **keep their names** and take the action as a prop. Two lines are
untouched:

- `|| !multiUserMode` — a single-user deployment has no principal and an empty map; gating it on
  a capability locks it out of its own settings (#40 t4).
- `if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />` — a wrong redirect is
  not recoverable by waiting, unlike a late render (#127). Still **inherited-untested**: deleting
  it leaves 15/15 green because `isAuthd === null` covers for it. Carry the mark, do not claim
  coverage.

**Scope = the flagged rows + any row whose capability changes as a result.**

## (c) Corrections to the recon

### c1. system-prompt-variables IS a mismatch — TL-2 is right, and the harness was wrong

`SystemPromptVariables/index.jsx:27` calls `System.promptVariables.getAll()`.
`models/system.js:1015` re-exports `promptVariables: SystemPromptVariable`, so the call reaches
`models/systemPromptVariable.js` → `/system/prompt-variables`, gated **`system.read` /
`system.write`**. My extractor matched `Local.method(` only; `System.promptVariables` has no `(`
after it, so the call was dropped and the page reported no server calls.

**Harness re-pointed at re-exports and rerun. Result: exactly one entry hid this way** — this
one. `indirect` now records the hop
(`System.promptVariables -> systemPromptVariable.js.getAll`) so the path is auditable rather than
implied. Mismatch count **19 → 20**.

This is the fourth extraction bug of this shape in this audit and the second found by someone
else. Recorded in the recon's list.

### c2. interface and chat have no server state — confirmed by measurement

Both pages render only child components under `Settings/components/`, and **every one of them
uses `localStorage` and none references `API_BASE`**:

| component | API_BASE refs | per-viewer storage |
|---|---|---|
| LanguagePreference, ThemePreference | 0 | yes |
| AutoSubmit, AutoSpeak, SpellCheck, ShowScrollbar, AutoScroll | 0 | yes |

Their only server calls are the four every settings page makes (`/system/footer-data`,
`/system/support-email`, `/system/my-capabilities`, `/utils/metrics`).

**Ruling applied: remove the admin gate; ordinary authentication only.** These are per-viewer
display preferences stored in the browser. Gating them on `user.manage` means a member cannot set
their own theme or language — a real defect the audit found by accident, and the only row where
the fix *widens* access.

## (d) Remaining rows

**telegram — measured, all ten routes:**

| route | method | gates |
|---|---|---|
| `/telegram/config`, `/status`, `/approved-users`, `/pending-users` | GET | `validatedRequest`, `isSingleUserMode` |
| `/telegram/connect`, `/disconnect`, `/update-config`, `/approve-user`, `/deny-user`, `/revoke-user` | **POST** | `validatedRequest`, `isSingleUserMode` |

**Six mutating routes carry no `requirePermission`.** `isSingleUserMode` is a real gate — it is
why the route sweep does not flag them — but it answers *which deployment mode*, not *which
principal*. In single-user mode that is nearly the same question; it stops being so the moment
the deployment converts. Add `requirePermission` to all six; entry gates on the read action.

**scheduled-jobs stays `SingleUserRoute`.** Reason recorded so it is not re-litigated: the whole
feature is single-user-only, gated `isSingleUserMode` on all twelve routes, so the guard and the
routes already agree. It is not a mismatch — it is the one row where the two authorities match by
construction.

**`/utils/metrics` is a separate observation**, not this issue. Noted with `/setup-complete`:
both carry no middleware at all.

## Findings this contract does NOT resolve

**The read/write split cannot be derived from HTTP method.** `/system/custom-models` is a **POST
gated `system.read`** — a read operation shaped as a POST because it takes a body. Any
implementation that classifies by verb will mis-assign it, and `settings.embedder` is the row
where it shows: its "read" column measures empty while the page plainly reads. The dev must take
the action name as authoritative and treat the method as a hint. This is not hypothetical — my
own table has the wrong split on that row, printed above unaltered.

**12 capabilities remain absent from `ORG_CAPABILITIES`** after #121's four:
`browser-extension.read/write`, `chat.write`, `embed.read/write/delete`,
`invite.create/delete`, `model-router.read/write`, `workspace.delete`. A guard asking any of them
refuses every caller including `super_admin` — the #132 precondition, same mechanism. `org.member`
stays absent deliberately (#53). **Exposing these is a prerequisite slice, not part of the guard
conversion**, and it touches `endpoints/system.js`, so that slice is tier **auth**.

## Tier

**auth.** Route guards, permission actions, and a capability list are all in scope. Full QA plus a
Techlead verdict before merge, per §7.11a.

## Sequencing

Blocked on #121 merging. The sidebar's entry side is `roles: [...]` on main today and becomes
`capability:` in #121, so **every row's left-hand column changes**. Re-run the four harnesses on
the merged SHA before writing the plan; the numbers here are the pre-#121 state.
