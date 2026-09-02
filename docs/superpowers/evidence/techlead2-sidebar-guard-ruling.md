# Techlead-2 ruling — sidebar guard shape, and the audit issue's scope

**Skills invoked:** `security-review` (auth tier — this decides which principals reach
which admin pages). `requesting-code-review` does not resolve by name in this session
(`Unknown skill`, bare and `superpowers:`-namespaced), so the template was read from disk.
No `infi-lessons` line: the harness gap below is a measurement correction, not a new §7.17
failure class.

Measured against the seeded database and the real page sources, not the audit table alone.

---

## (a) The guard principle: gate on the READ action, hide the write controls

**Option 3.** A page is guarded by the action that makes it *readable*; controls that
mutate are gated separately on the write action, in the page.

Three reasons, in order of weight:

1. **A redirect is not recoverable; a hidden button is.** `AdminRoute` answers
   `<Navigate to={paths.home()} />`. A principal who can legitimately read the page and is
   bounced has no way to discover why — this is the #127 shape exactly (a manager passed
   `ManagerRoute`, saw the page, and got 403 from both of its calls: a page that renders
   and cannot work). Gating on write inverts it into a page that never renders for someone
   the server would have answered.
2. **The read action is the one the page's first request actually asks for.** Guarding on
   write means the guard and the server disagree on the *first* call, which is the call
   that decides whether the page shows anything at all.
3. **#121's R4 already did this for Users** — menu on `user.read`, buttons on
   `user.manage` — and the audit shows that row landing `OK` with route actions
   `user.manage, user.read`. This is not a new pattern; it is the one that already works.

**But split the guard from the visibility, and do not conflate them.** The sidebar
*entry*, the *route guard*, and the *write controls* are three decisions:

| layer | gates on | failure mode if wrong |
|---|---|---|
| sidebar entry | read action | menu item nobody can use, or hidden from someone who can |
| route guard | read action | irrecoverable redirect |
| in-page mutate controls | write action | 403 on save |

Entry and route guard must name the **same** action. Today they cannot even disagree
visibly, because the route guards are role strings — which is (b).

**Do not let a page be gated on an action its own routes never check.** That is the
mechanical test the audit already applies, and it is the right one. The four genuine
mismatches (`mailer`/`text-splitting` swap, `community-hub.trending`,
`community-hub.import-item`) are all repairs *toward* this rule, and the two Model-Router-
shape rows are the same fix in two parts (add the read action to `ORG_CAPABILITIES`, gate
the entry on it).

I checked the cost against the seeded roles before ruling, because "gate on read" is only
free if read is not held more widely than write:

```
system.read  -> super_admin            system.write -> super_admin
settings.write -> setup_admin, super_admin
key.manage   -> setup_admin, super_admin
embed.read/write, browser-extension.read/write, model-router.read/write -> super_admin
```

No org role holds a `*.read` without also holding its `*.write` today, so this ruling
widens **nothing** on a default deployment. It is a correctness change for delegated
principals, not a loosening. Recorded because that is exactly the claim a reviewer should
demand evidence for.

## (b) Route guards convert in THIS issue, not a later one

The audit's own closing paragraph is the argument: #121 moved the sidebar off role strings
and left the route guards on them, so an entry can be capability-gated while the page
behind it is role-guarded. Splitting the conversion out means shipping a release where the
menu and the page disagree by construction — and the disagreement is invisible to every
test, because each layer is internally consistent.

Concretely, `ManagerRoute` gates `can("user.manage")` (`PrivateRoute/index.jsx:146`). So
`settings.browser-extension` — whose routes check `browser-extension.read`/`.write` —
is reachable only by a principal holding `user.manage`, an action with nothing to do with
the feature. Fixing the entry's capability while leaving that guard in place produces a
menu item that appears for the right principal and then redirects them home. That is a
worse state than today.

Scope discipline, since this is a real risk of a wide issue: convert the guards for the
**rows the audit flags**, plus any row whose entry capability changes as part of the fix.
`AdminRoute`/`ManagerRoute` stay as names; what changes is that they take the action as a
prop rather than hardcoding one, so a page can name its own. The `|| !multiUserMode`
short-circuit and the `capabilitiesLoading` hold are load-bearing and must survive
untouched — #40 task 4 and #127 both turned on them.

## (c) Class 3 — the audit table is wrong on one of these three; I measured it

**`settings.system-prompt-variables` does NOT belong in class 3.** Its page calls
`System.promptVariables.getAll()` (`pages/Admin/SystemPromptVariables/index.jsx:27`);
`System.promptVariables` is a re-export of `models/systemPromptVariable.js`
(`models/system.js:1015`), which fetches `/system/prompt-variables`. Those routes are
gated:

```
GET    /system/prompt-variables      requirePermission("system.read",  orgResource)
POST   /system/prompt-variables      requirePermission("system.write", orgResource)
PUT    /system/prompt-variables/:id  requirePermission("system.write", orgResource)
DELETE /system/prompt-variables/:id  requirePermission("system.write", orgResource)
```

This is the harness caveat firing — "a call made through an unusual indirection is not
counted" — and the re-export is exactly that indirection. So this row is a **fifth genuine
mismatch**: it gates on `settings.write` and its routes check `system.read`/`system.write`.
Under rule (a) it gates on `system.read`. Dev4 should re-point the harness at model
re-exports before the issue is scoped, because if one row hid this way others may too.

**`settings.interface` and `settings.chat` genuinely call no server route — because they
have no server state at all.** Measured through the component tree:

- `Interface` renders `LanguagePreference` (i18n only) and `ThemePreference`
  (`hooks/useTheme.js:29,54` — `localStorage.getItem/setItem("theme")`).
- `Chat` renders six toggles, each writing `Appearance.updateSettings(...)`, which is
  `localStorage.setItem(APPEARANCE_SETTINGS, …)` (`models/appearance.js:28-30`).

These are **per-viewer browser preferences**. Gating them on `settings.write` is not
merely unfalsifiable, it is wrong in substance: it tells a member they may not choose their
own theme or spellcheck setting, and there is no server-side effect to protect. The fix is
not to find them an action — it is to **remove the admin gate** and leave them behind
ordinary authentication. Note both currently carry `ManagerRoute`, so today a delegated
admin holding every settings capability cannot change their own theme.

If anyone objects that these pages live under `/settings/`, that is a navigation fact, not
an authorization one.

## (d) Class 4 — the two ungated entries

**`settings.available-channels.telegram`: gate it.** I did not measure its routes myself
in this pass, so the disposition is: Dev4 measures what the page calls, and if any route
mutates instance state, that route gets a `requirePermission` and the entry gates on the
matching read action. "There is no action to name" is a reason to add one, not a reason to
leave an `AdminRoute`-only page ungated — a client guard is not an authorization boundary
(#127's ruling: *the frontend cannot hold this decision*).

**`settings.scheduled-jobs`: leave it, and record why.** It carries `SingleUserRoute`,
which is `isAuthd && !multiUserMode` — no capability, by construction. In single-user mode
there is one principal and nothing to separate, so a capability gate has nothing to
express. This one is correctly ungated. If it ever becomes reachable in multi-user mode,
it needs a real action first.

## The four "genuinely open" routes, confirmed

Asked separately; all four are intentional, and three are not what "open" suggests:

- **`GET /setup-complete`** — deliberately unauthenticated *and narrowed*: it calls
  `publicSettingsFor(settings, { authenticated, preUser })`, so an anonymous caller gets a
  reduced payload. `validatedRequest` is used to *learn* whether there is a session, not as
  a gate. Its own comment says so. Correct as written.
- **`GET /system/footer-data`, `GET /system/support-email`** — `validatedRequest` only.
  Both return branding an authenticated user is meant to see; no principal separation
  applies. Correct.
- **`GET /utils/metrics`** — the one worth naming. Genuinely no middleware, and it returns
  `version`, `appVersion`, `VECTOR_DB`, mode, and host disk free/total GB
  (`endpoints/utils.js:112-119`). Predates the authz work (file added 2023-08-10). Not a
  finding for this issue and not a credential leak, but an unauthenticated
  version-and-disk fingerprint is worth a `validatedRequest` at minimum. Recorded as an
  observation, deliberately not folded into the sidebar issue — different lane, different
  reviewer.

## Summary for the issue

1. Guard on the **read** action; hide write controls on the write action; entry and route
   guard name the same action.
2. Route-guard conversion lands **in this issue**, scoped to the flagged rows.
3. Class 3 is **not three rows**: `system-prompt-variables` is a fifth mismatch (harness
   indirection gap — re-point the harness first); `interface` and `chat` have their admin
   gate **removed**, not repaired.
4. Class 4: `telegram` gets a server-side action; `scheduled-jobs` stays ungated on the
   record above.
5. Rule (a) widens access to **no** role on a default deployment — verified against the
   seeded `role_permissions`, not asserted.
