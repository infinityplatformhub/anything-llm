# Ledger — issue 72, `updateSettings` discards unknown keys and answers success

`updateSettings` filtered the caller's keys against `supportedFields`, deleted the rest **from the caller's own object**, and passed the remainder to `_updateSettings`. Probed on a real database before writing anything:

```
updateSettings({not_a_real_key:"x"})                        -> {success:true, error:null}, 0 rows
updateSettings({not_a_real_key:"x", support_email:"a@b.c"}) -> {success:true}, support_email IS written
   input BEFORE {"not_a_real_key":"x","support_email":"..."} AFTER {"support_email":"..."}
```

Two defects in one function: a typo is answered "saved", and a mixed body applies half of itself while silently editing the caller's record of what it asked for.

Ruling: **typed by `code`, not by parsing the error string.** `{success:false, error, code:"unknown_keys", unknownKeys, unknownKeyCount}`. Routes branch on `code`. If wrong, a route's behaviour is coupled to the wording of a message, which breaks the day anyone improves the wording.

Ruling: **all-or-nothing.** One unknown key means nothing is written, including the valid keys in the same body. The alternative — apply what we understood — leaves a state neither side can reason about afterwards, and the caller cannot tell which half landed.

Ruling: **`protected_keys` is `protectedFields` MINUS `supportedFields`.** This was the blocker of the issue and it took three attempts. `protectedFields` reads like a denylist but `hub_api_key` is in **both** lists, and it is the key `POST /community-hub/settings` writes. A flat `protectedFields.includes(key)` check refuses it and breaks Community Hub connect and disconnect for every user (`GeneralSettings/CommunityHub/Authentication/index.jsx:34,53`). Only `multi_user_mode` and `onboarding_complete` are protected-and-not-supported.

Ruling: **the overlap invariant is derived, not hardcoded.** The test computes `protectedFields ∩ supportedFields`, asserts it is non-empty (a hardcoded `hub_api_key` assertion would pass forever after someone removed the overlap, proving nothing), then writes every key in it and reads each row back. A test naming `hub_api_key` catches today's bug and not the second key someone adds to both lists — the same generalisation gap #70's sweep turned out to have, which is why it is written this way here.

Ruling: **reflected keys are capped.** `unknownKeys` echoes caller-controlled text, so: at most 50 entries, each key longer than 64 **code points** truncated with `…`, and `unknownKeyCount` carrying the true total. Exactly 64 is not truncated. Length is `[...key].length`, not `key.length` — a key of 64 emoji has a `.length` of 128 and a naive check would truncate it. Without `unknownKeyCount`, a caller who sent 200 bad keys sees 50 and cannot tell the list was cut, which is the same silent-truncation defect this issue exists to remove.

Ruling: **`__proto__`, `constructor`, `prototype` are ordinary unknown keys.** No special code. The assertion that matters is not the 400 — it is that `({}).pwned` is still `undefined` after a request that tried to inject it.

Ruling: **the manager path keeps answering 200 with zero rows written.** When the actor lacks `system.write`, `admin.js:583-604` rebuilds the body from `managerAllowedFields` before the model sees it, so no refusal is reachable there. A 400 would be an oracle — a low-privilege caller could enumerate which settings exist one probe at a time. Deliberate, commented at the site, and pinned by a test asserting 200 with an unchanged database. The adjacent defect (a manager silently losing a write to a *supported* key) is issue #78.

Ruling: **`/community-hub/settings` keeps returning the model's result verbatim.** Its success body changed from a hardcoded `{success:true,error:null}` to whatever `_updateSettings` returned. The only frontend caller reads `res.ok` and `response.error`, so nothing breaks. Reverting to the hardcode would make this the one route that still claims success unconditionally — the exact defect #70 swept out.

## Verification

Everything below I ran myself against `bac9c118`/`b1b08461`; the implementer's numbers were not taken on report.

| claim | result |
|---|---|
| `hub_api_key` writable, row reads back | `true`, `verify-key` |
| `multi_user_mode` / `onboarding_complete` | both `protected_keys` |
| 63 chars verbatim / 64 not truncated / 65 truncated + `…` | all true |
| truncated key still one entry (3 in, 3 out) | true |
| 60 unknown keys → list 50, `unknownKeyCount` 60 | `50 60` |
| 64 emoji NOT truncated (code-point measurement) | true |
| `__proto__`/`constructor`/`prototype` → `unknown_keys` | true, `({}).pwned` undefined |
| input object unchanged, key order preserved | true, true |
| three suites | 41/41 |

**Mutation on the blocker fix**: reverting the protected filter to the flat `protectedFields.includes(key)` fails `every protected and supported key remains writable` and nothing else — the invariant test discriminates, and the working tree was verified clean after restoring.

Three further mutations, each failing a **different** test, so a defect in one area cannot hide behind another:
- collect `unknownKeys` after filtering → `mixed input reports unknown keys before filtering`
- `delete` instead of copy → `refusal preserves deep input and key order`
- a route left on `!success → 500` → `admin route rejects mixed keys without changing any database row` (expected 400, received 500)

All-or-nothing is proven by a full ordered snapshot of `system_settings` before and after the mixed request, on both the admin and `/v1` surfaces, **including the case where the valid key is set to the value it already holds** — a diff-based check passes that case for the wrong reason.

## A note on how this one went

The implementer reported the blocker fixed twice while it was not, and in the second round had written tests that asserted the broken behaviour — `test.each([... "hub_api_key" ...])` and an HTTP assertion on `protectedKeys: ["hub_api_key"]`. The suite was green at 39/39 because the assertions had been written to match the code rather than the requirement. Running the model directly is what caught it, both times. Green numbers from a report are not evidence; §7.9 says so and this is the case that demonstrates why.
