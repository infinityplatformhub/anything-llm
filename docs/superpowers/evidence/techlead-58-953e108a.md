# Techlead review — #58 final `953e108a` (ruling C revised)

**Verdict: PASS**, one nit (below). Read-only review on the SHA; no runtime code touched.

## The six checks PMO asked for

| check | result | where |
|---|---|---|
| repair runs before `listen()` | ✓ | `boot/index.js:35` (bootSSL) and `:92` (bootHTTP) — `await repairDeploymentShape()` is the first statement after the `app` guard, before `app.listen`. The boot callbacks run *after* the socket is open, so anything inside them would be repairing while already serving. |
| `.catch` on both call sites | ✓ | `index.js:94` `bootSSL(...).catch(refuseBoot)` and `:202` `bootHTTP(...).catch(refuseBoot)`. `refuseBoot` prints and `process.exit(1)`. The banner correctly changed from `[BOOT REFUSED]` to `[BOOT FAILED]` — the old wording described a policy that no longer exists. |
| DB outage does not touch the setting | ✓ | `assertDeploymentShape.js:32-41` — both reads inside one `try`; on throw it returns `{repaired:false, reason:"unreadable"}` *before* any write, and logs `could not read deployment shape` rather than the misconfiguration message. Test `an unreadable database is not repaired and not relabelled` injects a throwing `db`. |
| `/request-token` guard uses `users.count()` | ✓ | `system.js:353` `if ((await User.count()) > 0)` inside the `else` (single-user) branch. `User.count()` → `prisma.users.count({where:{}})`. The setting is not consulted in the guard. |
| positive control: genuine single-user still mints | ✓ | `requestTokenShapeB.test.js` first test — mode false, zero users, correct `AUTH_TOKEN` → 200 with a token. This is the test that fails if the guard were written as "never take this branch". |
| the 14 raw-reader table is real | ✓ (see below) |

## The 14-site table

`git grep -n "isMultiUserMode()" -- server` on `953e108a`, excluding tests, returns 22 hits. Reconciled:

- 3 are not readers: `actorResolver.js:278` (a comment), `deploymentMode.js:37` (a comment), `validatedRequest.js:11` (a comment).
- 1 is the helper's own body: `actorResolver.js:303`, inside `isConfirmedSingleUser`.
- 1 is the repair itself: `assertDeploymentShape.js:30` — correct, it must read the raw setting to detect the disagreement.
- 1 is `endpoints/system.js:236`, the `/request-token` branch selector — left raw *deliberately*, and that is the right call: the two branches authenticate against different credentials, so flipping the predicate reroutes authentication rather than tightening it. `User.count()` inside the else-branch closes the hole without moving the branch.

The remaining 16 map onto the ledger's table. Two rows the ledger lists were fixed rather than left (`deploymentMode.js:20` `isMultiUserSetup`, and `mobile/middleware/index.js:70`), so the "reviewed, no change" count is 14 only after those two move out — which is what the ledger says. Table is accurate.

Spot-checked the three rows where "no access decision" is a claim rather than an observation:
- `markOnboarded.js:48` — early-return of a "has this instance been used" heuristic. No caller reads it for authorization.
- `agents/defaults.js:127` — selects which built-in skills load. Wrong skill list, no skipped check.
- `PushNotifications/index.js:112` — chooses which subscription set to load.

All three fail toward *less* function, not less checking.

## Structural points I checked beyond the brief

- **`isMultiUserSetup` moved to the confirmed helper** (`deploymentMode.js:26`). It failed CLOSED in shape (b), so it was never a hole; fixing it anyway is right for the reason the comment gives — half a file on one predicate reads as a deliberate distinction to the next editor.
- **`MODE_REPAIR_ACKNOWLEDGED` silences the log, not the repair.** Asserted by test. An env var that quietly disabled the fix it names would be the worse failure.
- **The repair message carries the undo SQL and the user count.** Both asserted.
- **Ordering of the guard vs. the audit event.** The guard emits `failed_login_invalid_password` and returns the same `[003]` body as a genuine bad password. An unauthenticated caller cannot tell which branch refused. Correct per §3.4.

## NIT-1 — the repair does not check that its write landed

`assertDeploymentShape.js:45`:

```js
await SystemSettings._updateSettings({ multi_user_mode: true });
```

`_updateSettings` (`systemSettings.js:712-747`) **catches and returns `{success:false, error}`** rather than throwing. The return is ignored, so a failed write produces:

1. `FAILED TO UPDATE SYSTEM SETTINGS <msg>` from the model, then
2. `[DEPLOYMENT SHAPE REPAIRED] ... multi_user_mode has been set to true`, and
3. `{repaired: true}` to the caller.

Two contradictory messages, and the loud one is the false one. The instance boots still in shape (b).

Severity: low. The `/request-token` guard is independent of the setting, so no authentication bypass follows; the residue is that the 14 raw readers still disagree and the operator has been told they do not. Fix is one line:

```js
const { success, error } = await SystemSettings._updateSettings({ multi_user_mode: true });
if (!success) { console.error(`[deployment-shape] repair FAILED: ${error}`); return { repaired: false, reason: "write-failed" }; }
```

Not a blocker for merge — record as residual if Dev2 has moved on.

## Note (not a finding)

`SystemSettings.isMultiUserMode()` also swallows errors and returns `false`. So a settings read that fails while `users.count()` succeeds reads as shape (b). The repair that follows is still the *correct* write (user rows present genuinely means multi-user), so this does not produce a wrong outcome — worth knowing rather than fixing.
