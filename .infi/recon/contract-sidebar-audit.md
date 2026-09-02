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

**"Read" and "write" are decided by the ACTION NAME, never by the HTTP method** (TL-1
ee5005403 — promoted into the rule because it is part of applying it, not a caveat about it).
`/system/custom-models` is a **POST gated `system.read`**: a read that takes a body. Any
classifier that reads the verb files it as a write and gets the row wrong. Actions are
`<noun>.<verb>`; the suffix answers it, and a suffix nothing recognises must surface as
**unknown** rather than be guessed — an unclassifiable action is a question for a human, not a
default. The harness now does exactly this (`actionKind`, `sidebar-audit-calls.cjs`), so a rerun
cannot regenerate the error.

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

### Evidence contract — the guard behaviours a conversion must not lose

| # | assertion | why it is here |
|---|---|---|
| **RF-P** | every action any converted guard names is present in `ORG_CAPABILITIES` | **derived from the guard call sites**, not a hardcoded list. A hardcoded one is stale on arrival: `system.read` is already in (#121), `model-router.read` arrives with #137, and this contract's own count moved 12 → 10 while being written. Deriving it means the check tracks the code instead of the document. |
| **RF-M** | single-user mode + an **empty** capability map still reaches the page | `\|\| !multiUserMode` must survive the conversion. A single-user deployment has no principal and an empty map, so a guard that consults the capability alone locks it out of its own settings (#40 t4). An empty map, not a permissive one — a fixture that supplies capabilities cannot witness this. |
| **RF-L** | while the map is loading, the guard renders the **loader**, not a redirect — with `isAuthd` forced true | the `capabilitiesLoading` hold. Forcing `isAuthd` true is the whole point: `isAuthd === null` otherwise covers for the line, which is why deleting it today leaves 15/15 green. This is the test that converts the #132 `inherited-untested` mark into real coverage, and it belongs here rather than in #132 because the conversion is what puts the line on the critical path. |
| **RF-W1** | a principal with **no capabilities** changes the theme on `/settings/interface` and it persists | the ungating in c2 is a behaviour change, and this is the only assertion that shows it works rather than that a guard was deleted. |
| **RF-W2** | **no route middleware array moves** in the interface/chat slice | ungating is a client-guard change only. If a server middleware array shifts, the slice has grown into something else and the tier assumption with it. |

RF-M and RF-L guard the two lines listed above as untouched; without them "untouched" is an
intention rather than a checked property.

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
the deployment converts.

**Use the actions that already exist. Do not invent any** (TL-1 ee5005403). Measured on the
seeded database:

| action | holders | used by any `requirePermission` today |
|---|---|---|
| `telegram.read` | `super_admin:org` | **no** |
| `telegram.write` | `super_admin:org` | **no** |

Both are seeded, both are in the engine's vocabulary (`engine.js:35`,
`prisma/seeds/permissions.js:85-86`), and **neither is referenced by a single gate** — the #63
shape: a permission that exists, is granted, and enforces nothing. `setup_admin` holds **neither**,
and per TL-1 it must not be granted them here.

Entry gates on `telegram.read`; the six POSTs take `telegram.write`.

**State plainly in the issue: this NARROWS access for existing deployments.** Today any
authenticated caller on a single-user instance can connect, disconnect, reconfigure and approve
Telegram users. Afterwards only a `super_admin` can. That is the correct end state and it is
still a capability people have today and will lose — it belongs in the issue body, not
discovered from a support ticket.

**scheduled-jobs stays `SingleUserRoute`.** Reason recorded so it is not re-litigated: the whole
feature is single-user-only, gated `isSingleUserMode` on all twelve routes, so the guard and the
routes already agree. It is not a mismatch — it is the one row where the two authorities match by
construction.

**`/utils/metrics` is a separate observation**, not this issue. Noted with `/setup-complete`:
both carry no middleware at all.

## Findings this contract does NOT resolve

**~~The read/write split cannot be derived from HTTP method.~~ FIXED — see rule (a).** The
finding stands; the defect it described has been repaired at the source rather than left as a
caveat, per TL-1 ee5005403.

> **Correction, footnoted rather than silently applied.** The earlier version of this contract
> printed `settings.embedder` as `read=[] write=['system.read','system.write']` and told the dev
> to work around it. That row was wrong: `/system/custom-models` is a POST gated `system.read`,
> and a verb-based classifier filed the read as a write. The harness now splits on the action
> name (`actionKind`), and the rerun gives **`settings.embedder → read=['system.read']
> write=['system.write']`**. Verified across all rows: **zero actions fall into `unknown`**, so
> no row is being classified by a default. A rerun can no longer regenerate the error, which is
> the part that mattered — a caveat in a document does not survive the next person regenerating
> the table.

**~10 capabilities remain absent** after #121's four — a figure that goes stale as issues land
(TL-1: #137 adds `model-router.read`), which is why **RF-P derives the check from guard call
sites rather than pinning a count**. Corrected from 12 in
`recon-orgcaps-prereq.md`: `workspace.delete` is already exposed via `WORKSPACE_CAPABILITIES`
(checked against that list too, not only the org one), and `org.member` stays absent deliberately
(#53). The 10 are `browser-extension.read/write`, `chat.write`, `embed.read/write/delete`,
`invite.create/delete`, `model-router.read/write`. A guard asking any of them refuses every
caller including `super_admin` — the #132 precondition, same mechanism. **Exposing these is a prerequisite slice, not part of the guard
conversion**, and it touches `endpoints/system.js`, so that slice is tier **auth**.

## Note for whoever touches the action registry (#141)

The permission registry is a **null-prototype object on purpose**. Anything iterating or
extending it must not assume `Object.prototype` methods are present, and must not "fix" the
missing prototype — it is what stops an action named `constructor` or `toString` resolving to an
inherited function. Relevant here because RF-P derives its expectation by walking guard call
sites and comparing against that registry.

## Tier

**auth.** Route guards, permission actions, and a capability list are all in scope. Full QA plus a
Techlead verdict before merge, per §7.11a.

## Sequencing

Blocked on #121 merging. The sidebar's entry side is `roles: [...]` on main today and becomes
`capability:` in #121, so **every row's left-hand column changes**. Re-run the four harnesses on
the merged SHA before writing the plan; the numbers here are the pre-#121 state.
