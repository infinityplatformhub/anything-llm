# #58 recon — one answer to "which mode is this", everywhere

Author: Dev 2. Base: `approof/main` after #52. Root cause identical to #52's addendum 7.

## 0. The pattern

`SystemSettings.isMultiUserMode()` reads the raw setting. `isConfirmedSingleUser()` requires the setting AND zero user rows. Shape **(b)** — `multi_user_mode = false` WITH user rows — makes them disagree, and every site that reads the raw setting to decide *whether to check something* skips the check.

`validatedRequest` already uses the confirmed helper, so in shape (b) it authenticates a session JWT while these sites believe the instance is single-user and wave the request past.

## 1. Sites, measured on the current tree

`isMultiUserMode()` has **25** call sites. Four were named in the brief; a fifth carries the same bypass and is not on it.

### Must change — the guard decides whether a check happens

| site | consequence in shape (b) |
|---|---|
| `utils/middleware/validBrowserExtensionApiKey.js:11,17` | `multiUserMode && (!user \|\| user.suspended)` — the whole clause is skipped, so **a suspended user's extension key keeps working** |
| `endpoints/mobile/middleware/index.js:70` | **NOT IN THE BRIEF.** Identical shape: the `if (multiUserMode)` block is the only place the token's user is loaded, checked for existence, and checked for suspension. In shape (b) a registration token for a deleted or suspended user registers a device |
| `utils/middleware/validApiKey.js:105` | stamps `locals.multiUserMode`, which downstream handlers branch on |
| `utils/agents/aibitat/plugins/websocket.js:17` | `if (!multiUser) return true` — **returns authorized before any engine call** |

Per ruling A/B, `validApiKey` and `validBrowserExtensionApiKey` write
`locals.multiUserMode = !(await isConfirmedSingleUser())` — inverted, not substituted — so the local keeps meaning "is this multi-user" for the handlers that read it. `endpoints/mobile` takes the same treatment.

Per ruling D, `websocket.js:17` is a **separate commit**, not part of the sweep.

### Reviewed, no change — the answer is reported, not acted on

| site | why it stays |
|---|---|
| `models/systemSettings.js:470` | `MultiUserMode` in `currentSettings()` — reports the SETTING, which is what the admin UI shows and edits |
| `endpoints/system.js:762` | `GET /system/multi-user-mode` — same, the setting is the answer being asked for |
| `endpoints/utils.js:22` | health-check `mode` string; cosmetic |
| `utils/boot/markOnboarded.js:48` | "has this instance been used" heuristic at boot; no access decision |
| `utils/agents/defaults.js:127` | selects which built-in agent skills load; not a permission |
| `utils/agents/aibitat/plugins/{gmail,google-calendar,outlook}/lib.js` (6 sites) | pick which credential record to read (per-user vs instance); wrong answer reads the wrong row, does not skip a check |
| `utils/telegramBot/index.js:172` | `checkMultiUserMode()` reports mode to the bot's own config UI |
| `utils/PushNotifications/index.js:112` | chooses which subscription set to load; no check skipped |
| `utils/middleware/simpleSSOEnabled.js:22,66` | **#50 deletes the issuance half.** The remaining `simpleSSOLoginDisabledMiddleware` uses it to decide whether the no-login policy applies at all — in shape (b) it would apply the policy less often, which fails OPEN toward letting people log in normally. Flagged; deferred to #50's owner rather than changed under two issues at once |
| `utils/middleware/deploymentMode.js:20,31` | line 31 fixed in #52; line 20 is `isMultiUserSetup`, the mirror image — see §3 |
| `utils/authorization/actorResolver.js:278,303` | inside `isConfirmedSingleUser` itself |
| `utils/middleware/validatedRequest.js:11` | already the confirmed helper (#46) |
| `endpoints/system.js:236` | ruling C — see §2 |

## 2. Ruling C: `/request-token` needs more than a predicate swap

The two branches authenticate against **different credentials**: multi-user compares the password against the `users` row, single-user compares against `process.env.AUTH_TOKEN`. Flipping the predicate on a legacy instance therefore does not tighten a check — it sends the request down a *different authentication mechanism*.

**How shape (b) actually arises here, and it is not only restores.** `POST /system/enable-multi-user` (`system.js:712-728`) does:

```
User.create({...})                                  ← commits
SystemSettings._updateSettings({multi_user_mode: true})  ← separate write
...seven migrateToMultiUser calls
```

These are **not in one transaction**, but the handler DOES have a `catch` that rolls back (`User.delete({})` plus `multi_user_mode: false`). **Correcting my first reading of this**: a thrown `_updateSettings` is therefore handled, and the window is narrower than "any failure between the two writes". What the catch cannot cover is the process not surviving to run it — SIGKILL, OOM, container eviction, host loss — between `User.create` committing and `_updateSettings` committing. That window is small but real, and it is not the only source: a restore of a `users` dump against a fresh `system_settings`, or a settings row deleted by hand, reaches the same state.

So the population is small and not measurable from here (see below), but the state is reachable without anyone doing anything wrong.

**Measured, for what it is worth:** scanning every PostgreSQL database reachable on this machine found exactly two in shape (b), and **both are test artifacts** — one is this issue's own fixture, the other is `routeWiring.test.js`'s leftover (`t4a_it_b309682a`, one `manager` row). There is no production data here, so this count answers "is the state reachable" (yes, and test suites reach it routinely) and NOT "how many real installs are in it". That second question needs someone with production access; I cannot answer it and am not going to imply otherwise.

**Recommendation for #58:** change the predicate AND make those two writes atomic, so the state cannot be produced going forward. For instances already in it, a boot-time reconciliation is the honest fix — if user rows exist and `multi_user_mode` is false, the instance IS multi-user and the setting is stale. That is a repair, not a guess: no code path creates a user row in genuine single-user mode.

**This needs a ruling before implementation.** Auto-repairing at boot changes an instance's mode without an operator asking, which is exactly the kind of thing that should not be a side effect of a hotfix. The alternative — refuse to boot with a clear message — is safer and louder. I recommend refusing to boot, because silently flipping a deployment into multi-user mode is a bigger surprise than a startup error that names the fix.

## 3. `isMultiUserSetup` — the mirror

`deploymentMode.js:20` refuses unless multi-user. In shape (b) it refuses on an instance that IS effectively multi-user, which fails CLOSED (a real admin is locked out of a route). Not a security hole, but it is the same disagreement, and leaving one half of the file on the confirmed helper and the other on the raw setting is how the next reader assumes it was deliberate. Change both, note the direction difference.

## 4. RED DoD

Every case runs against shape (b): `multi_user_mode = false` with user rows.

1. A **suspended** user's browser-extension key is refused. RED today.
2. A registration token naming a **suspended or deleted** user is refused by the mobile middleware. RED today; not in the brief.
3. `locals.multiUserMode` is `true` in shape (b) for both key middlewares — asserted directly, since ruling A/B keeps the local's meaning.
4. `userCanToggleTools` consults the engine rather than returning `true` (separate commit, ruling D).
5. `enable-multi-user` interrupted between the user write and the settings write leaves a state the next boot refuses to run in (or repairs — per the §2 ruling).
6. The 14 unchanged sites: no test. They are listed in ledger-58 with a one-line reason each, per ruling E.

## 5. Estimate

Half a day for the sweep. §2 is the real work and the reason this is not a one-line change repeated five times.
