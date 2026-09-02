# Ledger — issue 84, `/system/update-env` wrote credentials behind `settings.write`

`endpoints/system.js:731` gated the route with `requirePermission("settings.write", orgResource)` and passed `reqBody(request)` straight to `updateENV`, which has no narrowing by actor anywhere in it. On the rebased base that is **214 `KEY_MAPPING` entries, 92 of them `secret: true`** — `OPEN_AI_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_KEY`, `PGVectorConnectionString`, provider credentials generally.

`setup_admin` holds `settings.write` and not `system.write`. That role could write every credential on the instance.

Ruling: **raise the gate on the route, do not narrow per key** (PMO ruling (ข)). The reason this is a bug rather than a design is that the API-key surface for the identical operation already required the stricter permission — `utils/apiKeySecurity/scopes.js:77` declares `"POST /v1/system/update-env": "system.write"`. The session door was the looser of two doors onto the same behaviour, and raising it makes them agree. Per-key would have kept `setup_admin` able to write the 122 non-secret entries, but would have left the two surfaces still disagreeing, and added branching to a route whose whole defect was a missing check.

Cost accepted deliberately: `setup_admin` loses the ability to set non-secret provider settings. Verified this costs no working screen — all ten frontend callers of `System.updateSystem` (`frontend/src/models/system.js:269`) are behind `AdminRoute`: EmbeddingPreference, TranscriptionPreference, AudioPreference (stt and tts), ImageGenerationPreference, VectorDatabase, LLMPreference, ModelRouters, Admin/Agents, OnboardingFlow. None is a `ManagerRoute`. Recorded as residual: if a manager should ever configure providers, open a per-key issue then rather than leaving the hole open in anticipation.

Ruling: **do not put narrowing inside `updateENV`.** It has four callers, and `POST /system/update-password` reaches it on the single-user path where there is no actor to authorize — a check there would break it. The fix belongs at the one route that is wrong.

Ruling: **the test derives its keys from `KEY_MAPPING` at runtime and asserts no count.** This earned itself during the work: #80 merged mid-flight and grew the table from 213/91 to 214/92, and a suite naming keys or asserting a number would have gone red for a reason unrelated to what it checks. The issue's own description carried a wrong count earlier (95, from a `grep` that matched comment lines) — counting text instead of loading the module is the same error in a different costume.

## Verification

Run by me on `8ce29f43`, rebased onto `approof/main` `9c496229`; `git merge-base` equals main's HEAD.

`KEY_MAPPING` on that SHA: **214 keys, 92 secret** — loaded, not grepped.

Suite: **7/7**. Cases: premise guard, manager+secret refused with live and stored values unchanged, manager+non-secret refused, `system.write` holder writes the same secret body successfully, masked placeholder leaves the value untouched, scope-table agreement with `/v1`.

**Premise guard first**: the manager fixture goes through the real engine and must be `settings.write` allowed and `system.write` denied before any status is asserted — the exact condition the route branches on. `setup_admin` is the only seeded org role satisfying it.

**Two mutations, each failing different tests:**

| mutation | result |
|---|---|
| gate reverted to `settings.write` | `✕ refuses a manager secret write…` + `✕ refuses a manager non-secret write` — 2 failed, 4 passed |
| placeholder filter disabled in `updateENV` | `✕ leaves a secret untouched when the caller submits the masked placeholder` — 1 failed, 6 passed |

The second mutation is why that test exists. The UI resubmits forms containing secrets it never received in cleartext, sending asterisks in place of the value, and `updateENV` strips them before writing. This change puts a new gate in front of that path; a suite testing only refusals would not have noticed the allowed path starting to write literal asterisks over a live credential.

## Residuals

- `setup_admin` can no longer set the 122 non-secret entries (no UI exercised this).
- `updateENV` silently drops keys absent from `KEY_MAPPING` — the same silent-drop class as #72, one layer over, deliberately out of scope here.

## Note on how this one was finished

The implementer produced the correct one-line gate and a sound RED/GREEN/mutation, then reported the same result three times without acting on follow-up: the rebase was never done, and the masked-placeholder test asked for twice was never added. I rebased the branch myself (stashing its uncommitted work with a unique tag and reapplying, since the stash stack is shared across worktrees), added the missing test, ran both mutations, and committed. The pattern across this session is consistent — every report that diverged from the tree was caught by running the code, never by reading the report.
