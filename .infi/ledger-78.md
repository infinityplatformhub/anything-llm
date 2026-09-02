# Ledger — issue 78, manager writes to forbidden settings answered 200

`admin.js` asked the engine whether the actor may `system.write`; if not, it rebuilt the body from a 5-key `managerAllowedFields` literal and passed that on. Everything else was dropped there and the route answered as though the write happened. A manager posting `{memory_enabled:"true"}` was told it was saved.

## What the issue is actually about — two premises of mine were wrong

Ruling: **the reason is fidelity, not visibility.** My first framing said "managers can already see these settings in the UI." False — traced all 9 `updateSystemPreferences` call sites and their route guards; every key outside the allow-list sits behind `AdminRoute` or a `user.role === "admin"` gate. My second framing said "the names are sensitive, so naming them in a refusal is an oracle." Also false — `supportedFields` is a literal array in a public repository, identical in every build. What survives both corrections is simpler: **a write that was refused must not be answered as a success.** Same class as #70 and #72, one layer up.

Ruling: **all 23 keys**, not the UI-reachable subset. A rule keyed to which page happens to exist today drifts the moment a page is added.

Ruling: **authority before vocabulary.** The narrowing decides before `updateSettings` does. A mixed body `{unknown_key, memory_enabled}` from a manager is 403 (may you write at all) rather than 400 (do these names exist). For an actor holding `system.write` the same body is still 400 `unknown_keys` — #72 unchanged.

Ruling: **one classification, and no filtering.** `forbidden = (supportedFields ∪ protectedFields) − managerAllowedFields` → 403 naming only the keys the caller sent. Otherwise the body passes through **whole**. The union matters: `multi_user_mode` and `onboarding_complete` are protected and NOT supported, so a `supportedFields`-only test left them out of the forbidden set, and the filter then dropped them — 200, nothing written, the very defect this issue names. I argued at one point that this case should stay a silent 200 on oracle grounds and was wrong: `protectedFields` is as public as `supportedFields`, and there is nothing to protect.

Ruling: **`hub_api_key` answers by actor** — manager 403 `forbidden_keys`, `system.write` holder 400 `protected_keys`. A consequence of the ordering rule, not a special case.

Ruling: **six routes, not one.** The narrowing is worthless if another door writes the same keys:
- `admin.js` `POST /admin/system-preferences`
- `communityHub.js` `POST /community-hub/settings` (writes `hub_api_key`)
- `system.js` `POST /system/default-system-prompt` (writes `default_system_prompt`)
- `system.js:1102` `POST /system/upload-logo` and `:1137` `GET /system/remove-logo` — both call `_updateSettings` **directly**, bypassing `updateSettings` entirely, writing `logo_filename`
- `experimental/liveSync.js:44` `POST /experimental/toggle-live-sync`, same private path, writes `experimental_live_file_sync`

Ruling: **`POST /system/enable-multi-user` is fixed at the gate, not by narrowing.** It writes `multi_user_mode` through `_updateSettings` and creates the first admin, guarded by `settings.write` — which a manager holds. That is privilege escalation, not a settings write. The route legitimately must write that key during bootstrap, so the wrong thing is who may call it: `requirePermission("settings.write")` became `requirePermission("system.write")`. `utils/boot/assertDeploymentShape.js:50` writes the same key at boot and is deliberately untouched — boot has no actor to authorize.

Ruling: **one module-level const.** `managerAllowedFields` existed as two literals in the same file (`admin.js:465` read path, `:594` write path) — identical that day, unrelated the next. Lifted to `utils/managerSystemPreferences.js`, frozen, now used by six call sites plus the read path.

Ruling: **assert set relations, never a count.** `forbidden = supported − allowed`, `allowed ⊂ supported`. #80 adds SMTP fields to `supportedFields`; a test asserting "23 forbidden keys" would go red for a reason unrelated to its subject, teaching the reader to edit the number rather than think.

Ruling: **the drift test enumerates callers, not keys.** Every file calling `updateSystemPreferences` (11 today) must be manager-covered or in an explicit allowlist carrying a reason. The point is the twelfth file: whoever adds it is forced to decide which side it is on, instead of the test quietly ignoring it.

## Verification

Run by me on `144037b4` after rebasing onto `approof/main` `08bbb989` (#87 in the base). `git merge-base approof/main HEAD` equals main's HEAD.

**Behaviour proven by executing the function, not by grepping it** — with the engine stubbed to deny:

```
["not_a_real_key"]                passthrough {"not_a_real_key":"x"}
["support_email"]                 passthrough {"support_email":"a@b.c"}
["multi_user_mode"]               403 ["multi_user_mode"]
["hub_api_key"]                   403 ["hub_api_key"]
["not_a_real_key","hub_api_key"]  403 ["hub_api_key"]
```

Unknown keys reach `updateSettings` and come back 400 from #72; forbidden keys refuse and name only what was sent; no path returns 200 without writing.

Four suites together: **80/80** (`managerForbiddenKeysHttp`, `managerAllowedFieldsDrift`, `unknownKeyRefusal`, `unknownKeyRefusalHttp`).

**Four route-level mutations, four distinct single-test failures**: removing the check from `upload-logo`, `remove-logo`, `toggle-live-sync`, or the `enable-multi-user` gate each fails exactly one test naming that route, 403 expected and 200 received, with the rest green. That is what makes "six routes" a fact rather than a claim — each door is independently covered and a regression in one is not masked by the others.

**Premise guard** (`managerForbiddenKeysHttp.test.js`): before any status is asserted, the fixture actor goes through the real engine and must be `settings.write` **allowed** and `system.write` **denied** — the exact condition the endpoints branch on. Without it a test called "a manager is refused" can pass with a fixture that never reaches the branch. `setup_admin` is the only seeded org role satisfying it, verified against this worktree's own fresh seed.

A #72 test (`unknownKeyRefusalHttp.test.js:257`) asserted the old contract — manager + unknown key answering 200 — and was updated to 400 `unknown_keys`, keeping its before/after settings-table snapshot, renamed, and commented so the change reads as a decision rather than drift.

## How this one went, and what it cost

Three rounds were reported complete while the tree said otherwise: a SHA that existed in no branch; a filter "deleted" that had been rewritten as an equivalent loop; and a fix reported against the wrong file. Every one was caught by running the code, none by reading a report.

The filter case is worth keeping. Both the PMO and I used `grep -c fromEntries` as the acceptance check, saw `0`, and counted it done — while `managerSystemPreferences.js:43-47` did the same filtering with `Object.entries` and a conditional. **A grep for a symbol name measures spelling, not behaviour.** It is the same failure the #70 sweep had, and we reproduced it in our own acceptance criteria within hours of documenting it. The check that actually worked was calling the function with a denied actor and printing what came out.

## Follow-ups recorded, not done here

Docs-only, agreed non-blocking: comment the defensive dead 400 branch at `system.js:1014`; add a `{multi_user_mode:"true"}` row to the `directRoutes` e2e table, since `protected_keys` has never been exercised through a real route. NIT-1: the drift regex under-reports keys inside nested object literals — accepted, recorded.

Next: **#84** — `POST /system/update-env` is guarded by `settings.write` alone with no actor narrowing anywhere in `updateENV`, so `setup_admin` can write any of 213 `KEY_MAPPING` entries including the 91 marked `secret: true`. Its `/v1` twin already requires `system.write` (`scopes.js:77`), which is the strongest evidence the session route's gate is a mistake rather than a design. The const lifted here is the value that issue reuses.
