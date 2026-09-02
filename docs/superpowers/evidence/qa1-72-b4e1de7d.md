# QA-1 evidence — #72 @ `b4e1de7d` (lane: model / plugin / UI)

**Verdict: PASS with NIT-1** (unreachable 400 branch on `/system/default-system-prompt`)

Worktree `/tmp/qa1-72` (detached, QA-owned). Probes `/tmp/p72/`. DB `qa1_72` (fresh,
`migrate deploy`). Node 22. §7.14 — probe + mutation on related files, no full suite.

Baseline RED was captured on main **before** this SHA existed
(`docs/.../qa1-80-prereview.md` sibling method): the same harness, pointed at a server root,
so the before/after comparison is one script rather than two descriptions.

## 1. Model — seven cases, all correct

`/tmp/p72/model.cjs` stubs `_updateSettings` and records whether it was called at all.

| case | before (main) | after (`b4e1de7d`) |
|---|---|---|
| A unknown only | `success:true`, wrote nothing, **mutated** | `success:false code:unknown_keys`, **not called**, not mutated |
| B **mixed unknown+valid** | **wrote `support_email`**, mutated | `success:false code:unknown_keys`, **not called**, not mutated |
| C readable-not-writable only | `success:true`, mutated | `code:unknown_keys` listing all three |
| D protected only | `success:true`, mutated | `success:false code:protected_keys` `["multi_user_mode","onboarding_complete"]` |
| E **mixed protected+valid** | **wrote `support_email`**, mutated | `success:false code:protected_keys`, **not called** |
| F positive control (valid only) | wrote | wrote, `success:true` |
| G empty body | `success:true` | `success:true` — still 200, correctly |

B and E are the all-or-nothing cases. E is the shape I raised in pre-read as a second mixed
form; it is handled, and separately from B via its own code.

G matters as a non-regression: an empty body still succeeds. A refusal keyed on "nothing was
written" rather than "keys were rejected" would have broken it.

## 2. Reflection limits

- **50-key cap**: 120 unknown keys → 50 reflected, `unknownKeyCount: 120`
- **64-char cap**: a 200-character key → 65 code points, ends `…`
- **Code points, not code units**: a key of 100 emoji → 65 code points, and the truncation
  does **not** end mid-surrogate. Verified by regex against the trailing lone high surrogate.

## 3. Prototype keys

`__proto__`, `constructor`, `prototype` are each refused as ordinary unknown keys
(`code:unknown_keys`), `{}.x` stays `undefined`, and `safeUpdates` reaches `_updateSettings`
with `Object.getPrototypeOf(...) === null`.

## 4. `hub_api_key` and the anti-vacuity invariant

`hub_api_key` is in **both** `protectedFields` and `supportedFields`, and still writes
(`success:true`, key reaches the writer). The protected filter is
`protectedFields ∩ ¬supportedFields`, so the invariant that makes it non-vacuous is that the
overlap is non-empty:

```
protected ∩ supported = ["hub_api_key"]
```

Measured, not assumed. If that overlap ever empties, the filter degenerates to
"all protected keys are refused" and `hub_api_key` silently stops working.

## 5. HTTP — four surfaces

Driven through real auth and routing, with `support_email` read from the database before and
after each request to prove the write did or did not happen.

| surface | unknown | mixed unknown | protected | mixed protected | valid (control) |
|---|---|---|---|---|---|
| `POST /admin/system-preferences` | 400 | 400 | 400 | 400 | 200 + wrote |
| `POST /v1/admin/preferences` | 400 | 400 | 400 | 400 | 200 + wrote |
| `POST /community-hub/settings` | 400 | 400 | 400 | 400 | 200 + wrote |
| `POST /system/default-system-prompt` | 200 | 200 | 200 | 200 | 200 |

`code` is correct on every 400, and `wroteSupportEmail=false` on all of them — the refusal is
all-or-nothing at the route, not only in the model.

The fourth row is correct behaviour, and is NIT-1 below.

## 6. Plugins unaffected

`gmail`, `google-calendar`, `outlook` each still return `{success:true}` and write their own
key (`gmail_agent_config`, `google_calendar_agent_config`, `outlook_agent_config`). All three
are in `supportedFields`, so no unknown-key refusal can reach them — confirming recon point 4
by execution rather than by reading.

#70's return-value fix is intact: `system.js` still reads `result.error`, not
`error.message`.

## 7. Mutation — 6 mutants, all killed

Baseline 41/41.

| # | mutation | result |
|---|---|---|
| M1 | collect `unknownKeys` **after** filtering (always empty) | **14 failed** |
| M2 | `delete` on the caller's object instead of copying | **1 failed** |
| M3 | admin route ignores `code` → 500 instead of 400 | **3 failed** |
| M4 | `protected_keys` check disabled | **2 failed** |
| M5 | 50-key reflect cap removed | **1 failed** |
| M6 | truncate by code units instead of code points | **1 failed** |

M1 and M2 are the two the ruling named, and they fail on **different** tests — M2 is caught
solely by the null-prototype assertion, so the no-mutation property has its own guard rather
than sharing one with the unknown-key property.

## NIT-1 (non-blocking) — the 400 branch on `/system/default-system-prompt` is unreachable

`system.js:1010-1015` builds its own object:

```js
const { defaultSystemPrompt } = reqBody(request);
const result = await SystemSettings.updateSettings({
  default_system_prompt: defaultSystemPrompt,
});
if (["unknown_keys", "protected_keys"].includes(result.code))
  return response.status(400).json(result);
```

The key is a literal and `default_system_prompt` is in `supportedFields`, so no caller-supplied
key ever reaches `updateSettings` from this route. I confirmed by driving all four bodies at
it — every one answers 200, including all-unknown and all-protected.

The suite's `test.each(routes)` case that appears to cover it passes for a different reason:
its `bodyFor` for this route is `(body) => ({ defaultSystemPrompt: body.default_system_prompt })`,
which **discards** the unknown key, and the test mocks `updateSettings` to return
`code:"protected_keys"` outright. So it exercises the branch with a stubbed model, never with
a real refusal — the branch is proven to *work if reached*, not proven to be reachable.

Behaviour is correct either way, which is why this is not a blocker. Per PMO ruling, the
options are to delete the branch or mark it defensive with a comment saying why it cannot
fire. Recommend the comment over deletion: if this route ever forwards body keys, the branch
is the thing that keeps it consistent with the other three surfaces.
