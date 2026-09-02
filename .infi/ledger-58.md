# Ledger — #58: one answer to "which mode is this", everywhere

Base `84c42395` (main after #52). Branch `approof/hotfix-mode-predicate`.
Root cause identical to #52's addendum 7: `isMultiUserMode()` reads the raw setting, `isConfirmedSingleUser()` requires the setting AND zero user rows, and shape (b) — `multi_user_mode = false` with users present — makes them disagree. Every site reading the raw setting to decide WHETHER TO CHECK skips the check while `validatedRequest` authenticates real sessions.

## Rulings A and B

Ruling: `validApiKey.js:105` and `validBrowserExtensionApiKey.js:11` write `locals.multiUserMode = !(await isConfirmedSingleUser())` — INVERTED, not substituted, per the ruling. The local keeps meaning "is this multi-user" because handlers downstream read the boolean; replacing it directly would flip its meaning silently.

Ruling: the browser-extension case is a **suspension bypass**, not merely a mode confusion. The suspension check lives inside `multiUserMode && (!user || user.suspended)`, so in shape (b) the whole clause is skipped and a suspended user's extension key keeps working. RED proved it.

## Site the brief did not list

Ruling: `endpoints/mobile/middleware/index.js:70` (`validRegistrationToken`) is fixed here too, though ruling E lists it as "reviewed, no change". It is the same shape as A/B and not a reporting site: the `if (multiUserMode)` block is the ONLY place the token's user is loaded and checked for existence and suspension, so shape (b) registers a device for a suspended or deleted user. Its sibling `validDeviceToken` (same file, line 29) checks suspension UNCONDITIONALLY — the two middlewares in one file disagreed about whether suspension matters. Escalating rather than silently following the list would have left a live bypass.

## Ruling C — /request-token

Ruling: NOT changed in this commit, and the count PMO asked for cannot be answered from here.

Measured: scanning every PostgreSQL database reachable on this machine found exactly two in shape (b), and **both are test artifacts** — this issue's own fixture and `routeWiring.test.js`'s leftover `t4a_it_b309682a`. That answers "is the state reachable" (yes; test suites reach it routinely) and NOT "how many real installs are in it". There is no production data on this machine. Someone with production access has to answer the second question; reporting the local scan as if it were that number would be worse than reporting nothing.

Note: correcting my own recon. I first wrote that `enable-multi-user`'s two writes are unprotected. They are not in one transaction, but the handler HAS a rollback `catch` (`User.delete({})` + `multi_user_mode: false`), so a thrown `_updateSettings` is handled. The uncovered window is the process not surviving to run the catch — SIGKILL, OOM, eviction — plus restores and hand-edited settings rows. Smaller than I first claimed, still reachable.

Ruling: the reason C is not a predicate swap is that the two branches authenticate against DIFFERENT credentials — multi-user compares a password against the `users` row, single-user compares against `process.env.AUTH_TOKEN`. Flipping the predicate on a legacy instance does not tighten a check, it routes the request to another authentication mechanism. Needs its own ruling on the migration path (boot-time repair vs refuse-to-boot); I recommend refusing to boot with a message naming the fix, because silently flipping an instance into multi-user mode is a larger surprise than a startup error.

## Ruling C implemented — refuse to boot (PMO ruling)

Ruling: `utils/boot/assertDeploymentShape.js` refuses to boot when `multi_user_mode = false` AND `users.count() > 0`, with a message naming both remedies (set the setting true, or delete the leftover accounts). Refusing rather than repairing: flipping the setting on the operator's behalf silently changes what the instance IS — who may log in, and how — as a side effect of an upgrade.

Ruling: the check runs BEFORE `listen()`, not in the boot callbacks. Those callbacks execute after the socket is open, so a check there would be refusing while already serving requests — which is the state it exists to prevent.

Ruling: `bootHTTP`/`bootSSL` became async, so `index.js` attaches `.catch(refuseBoot)` at both call sites. Without it a rejection is an unhandled promise rejection and the operator-facing message is buried in a stack trace — the message IS the deliverable of a refuse-to-boot.

Ruling: an unreadable database does NOT refuse. A database outage is a different failure, and this check is not entitled to relabel it as "your deployment is misconfigured" and send the operator to edit `system_settings`. It logs and returns, letting the boot fail where it actually fails. Tested with an injected throwing client.

Ruling: `isMultiUserSetup` (deploymentMode.js:20) moved to the confirmed helper in the same commit. In shape (b) it failed CLOSED — refusing an instance that is effectively multi-user, an admin lockout rather than a bypass — so it was never a hole. Fixed anyway: one half of a file on the confirmed helper and the other on the raw setting reads as a deliberate distinction to whoever edits it next.

## Ruling D

Ruling: `agents/aibitat/plugins/websocket.js:17` NOT touched, per the ruling. `userCanToggleTools` returns `true` before any engine call when the setting says single-user, which is the same class, but its polarity is inverted relative to A/B and it needs tests for both. Separate commit.

## Ruling E — reviewed, no change (14 sites)

| site | reason |
|---|---|
| `models/systemSettings.js:470` | `currentSettings()` reports the SETTING, which is what the admin UI shows and edits |
| `endpoints/system.js:762` | `GET /system/multi-user-mode` — the setting IS the answer being requested |
| `endpoints/utils.js:22` | health-check `mode` string; cosmetic |
| `utils/boot/markOnboarded.js:48` | "has this instance been used" heuristic; no access decision |
| `utils/agents/defaults.js:127` | selects which built-in agent skills load; not a permission |
| `utils/agents/aibitat/plugins/gmail/lib.js:267,308` | picks per-user vs instance credential row; wrong row, no skipped check |
| `utils/agents/aibitat/plugins/google-calendar/lib.js:63,104` | same |
| `utils/agents/aibitat/plugins/outlook/lib.js:805,867` | same |
| `utils/telegramBot/index.js:172` | `checkMultiUserMode()` reports mode to the bot's config UI |
| `utils/PushNotifications/index.js:112` | chooses which subscription set to load |
| `utils/middleware/simpleSSOEnabled.js:22,66` | #50 deletes the issuance half; the remaining login-disabled policy fails OPEN in shape (b) (applies the restriction less often). Flagged to #50's owner rather than changed under two issues at once |
| `utils/middleware/deploymentMode.js:20` | `isMultiUserSetup`, the mirror of #52's fix: shape (b) makes it refuse an instance that IS effectively multi-user — fails CLOSED, an admin lockout rather than a bypass. Left for a decision; noting that one half of this file now uses the confirmed helper and the other does not, which will read as deliberate to the next person |
| `utils/middleware/validatedRequest.js:11` | already the confirmed helper (#46) |
| `utils/authorization/actorResolver.js:278,303` | inside `isConfirmedSingleUser` itself |

## Two false-green tests caught while proving RED

Note: the extension test first PASSED against the unfixed code. It asked for `document.read`, which the extension does not hold, so the middleware answered 403 "Insufficient scope" and never reached the suspension check the test exists to prove. Now uses `browser-extension.read` AND asserts the body, so the two 403s are distinguishable.

Note: the mobile test also passed, by calling `MobileDevice.createTempToken` — which does not exist. The value was `undefined`, the guard `if (!token) return;` fired, and the test asserted nothing at all. The real method is `registerTempToken`. Both are §7.9: a green test proves nothing until its RED failure names the missing behaviour.

## Evidence

Fresh database, `migrate deploy` from empty, `yarn test` on Node 22:
`Test Suites: 123 passed, 123 total` · `Tests: 1247 passed, 1247 total`
