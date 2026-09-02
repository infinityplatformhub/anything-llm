# Ledger — issue 78, manager writes to forbidden settings answered 200

`admin.js:589-604` asked the engine whether the actor may `system.write`; if not, it rebuilt the body from a 5-key `managerAllowedFields` literal and passed that on. Every other key — 23 of the 28 `supportedFields` — was dropped there, and the route answered as though the write had happened. A manager posting `{memory_enabled:"true"}` was told it was saved.

Ruling: **the reason is not visibility, it is fidelity.** My first two framings of this issue were both wrong and both corrected on the issue itself: (1) "managers can see these settings in the UI" — false, all 23 are behind `AdminRoute` or a `user.role === "admin"` gate, traced across all 9 `updateSystemPreferences` call sites; (2) "the names are sensitive, so refusing by name is an oracle" — also false, `supportedFields` is a literal array in a public repository, identical in every build. What survives is simpler and does not depend on either: **a write that was refused must not be answered as a success.** Same class as #70 and #72, one layer up.

Ruling: **all 23 keys answer 403 `forbidden_keys`**, not a subset chosen by UI reachability. A rule that depends on which page happens to exist today drifts the moment a page is added.

Ruling: **authority before vocabulary.** The manager check runs before `updateSettings`, so a mixed body `{unknown_key, memory_enabled}` from a manager is 403 (may you write at all?) rather than 400 (do these names exist?). For an actor holding `system.write` the same body is still 400 `unknown_keys` per #72 — the new check only affects actors who fail it.

Ruling: **the refusal names only what the caller sent.** Never reflect the allow-list; that would publish the whole policy in every refusal.

Ruling: **`hub_api_key` answers differently by actor** — manager 403 `forbidden_keys`, `system.write` holder 400 `protected_keys` (#72). A consequence of the ordering rule, not a special case.

Ruling: **unknown keys from a manager still answer 200 silently.** Deliberate, pinned by #72's test. A 400 there WOULD be an oracle: unknown-key names are not a published set, so a negative answer lets a caller probe for what exists. The asymmetry with the 23 is the point — one set is public, the other is not.

Ruling: **the narrowing covers three routes, not one.** This was the largest correction. `communityHub.js:31-37` (writes `hub_api_key`) and `system.js:1005-1012` (writes `default_system_prompt`) are guarded by `settings.write` alone, which `setup_admin` holds — so a manager refused at `/admin/system-preferences` could walk to either door and write the same forbidden key. A refusal that only one door honours is not a refusal. All three now call one `narrowManagerSystemPreferences`.

Ruling: **one module-level const, and the drift test derives from it.** `managerAllowedFields` existed as two separate literals in the same file (`admin.js:465` read path, `:594` write path) — identical that day, unrelated the next. Lifted to `utils/managerSystemPreferences.js` and frozen. The drift test reads that const rather than copying the names, so a copied literal cannot drift away from the thing it guards.

Ruling: **assert set relations, never a count.** `forbidden = supportedFields − managerAllowedFields`, and `managerAllowedFields ⊂ supportedFields`. #80 will add SMTP fields to `supportedFields`; a test asserting "23 forbidden keys" would go red for a reason unrelated to its subject, which teaches the next reader to edit the number instead of thinking. The subset assertion earns its place separately: an allowed key that is not a supported key would be dropped by the model instead of the route, which is the silent-success path this issue exists to close.

Ruling: **keep both overlap assertions.** `expect(overlap.length).toBeGreaterThan(0)` with a comment that it guards against the test going vacuous, then `expect(overlap).toEqual(["hub_api_key"])`. PMO proposed replacing the first with the second; the precise assertion alone fails with a message that reads like a missing key rather than a hollowed-out test, and one line buys the right diagnosis. PMO agreed.

## Verification

Run by me against `2a6b45a8`, not taken from the implementer's report.

- both suites **35/35**; working tree verified clean after every mutation

**Mutations, each isolating a different route or claim:**

| mutation | expected | result |
|---|---|---|
| strip the narrowing from `system.js` only | a `system.js`-specific test fails, others hold | `✕ refuses default_system_prompt through system route` — 1 failed, 32 passed |
| strip the narrowing from `communityHub.js` only | community-hub tests fail | `✕ refuses hub_api_key through community hub route` + `✕ keeps community hub route working for actor holding system.write` — 2 failed |
| add `memory_enabled` to the shared const | the drift test fails | `✕ matches fields written by manager-reachable settings components` |

The first two are what make the three-route ruling real rather than asserted: each route is independently covered, and a regression in one is not masked by the other two. The third proves the const lift actually happened — had two lists survived, adding a key to one would have left the drift test green.

**Premise guard confirmed present** (`managerForbiddenKeysHttp.test.js:128-142`): before any status is asserted, the fixture actor is put through the real engine and required to be `settings.write` **allowed** and `system.write` **denied** — the exact condition the endpoint branches on. Without it a test named "a manager is refused" can pass with a fixture that is not a manager and never reaches the branch. `setup_admin` is the only seeded org role satisfying it, verified by querying the policy store on this worktree's own fresh seed.

Positive controls are present per route, including `keeps community hub route working for actor holding system.write` — a route broken for everyone would otherwise pass every refusal test in the file.

## Follow-ups recorded, not done here

Docs-only, agreed non-blocking: comment the defensive dead 400 branch at `system.js:1014`; add a `{multi_user_mode:"true"}` row to the `directRoutes` e2e table, since `protected_keys` has never been exercised through a real route.

Next: **#84** — `POST /system/update-env` is guarded by `settings.write` alone with no actor narrowing anywhere in `updateENV` (grepped: zero matches for `system.write`, `managerAllowed`, `actor`), so `setup_admin` can write any of 213 `KEY_MAPPING` entries including the 95 marked `secret: true`. The const lifted here is the value that issue reuses.
