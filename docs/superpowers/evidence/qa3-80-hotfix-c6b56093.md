# QA-3 evidence — #80 hotfix `c6b56093` — PASS

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-hf`, own `yarn install` +
`prisma generate`, own database `qa3_hf`. Probes written independently of Dev3's
tests.

Two silent-failure sites and one writable proof. All three close.

## The two discarded return values

`SystemSettings.updateSettings` and `_updateSettings` **report** failure rather
than throwing, so discarding the return drops the write silently. Both call sites
now branch on it, and both messages say what actually happened rather than
something generic.

| id | scenario | result |
|---|---|---|
| F1 | `/mailer/test`, hash write stubbed to fail | **500**, `ok:false`, *"The test message was sent, but this configuration could not be recorded as verified. Send another test before saving."* — and the fixture recorded **1 `RCPT TO`**, so the mail genuinely went |
| F2 | `/mailer/settings`, settings write stubbed to fail | **500**, `saved:false`, *"The password was stored but the settings could not be saved…"*, and `smtp_host` is **absent** from `system_settings` |

F1's message is the one that matters. The operator watched the test message
arrive; being told it failed would be a lie, and being told nothing would strand
them in a 409 loop — save refusing for want of a hash a successful test never
wrote. The message names both halves: mail sent, proof not recorded.

F2 names a genuine split state rather than papering over it. The credential was
persisted and is live in the process; the settings it belongs to were not saved.
Nothing spans `credential_store` and `system_settings` transactionally, and the
comment says so and points at the residual entry instead of inventing a rollback.

Both are **500, never 400** — deliberately. Every label these routes write comes
from `SETTING_KEYS`, which is exactly what `supportedFields` contains, so
`unknown_keys` and `protected_keys` are unreachable by construction. A 4xx would
blame the caller for a bug no change to their request could fix.

## The save gate's own proof is no longer writable through the API

`smtp_verified_hash` moved from `supportedFields` to `protectedFields`.

| id | scenario | result |
|---|---|---|
| F3 | `POST /admin/system-preferences {smtp_verified_hash: "000…"}` | **400** `code: "protected_keys"`, and the stored value is **not** the forged one |
| F4 | the same, mixed with a legitimate `smtp_from_name` | **400**, and `smtp_from_name` is **unchanged** — the refusal is all-or-nothing, so a forged hash cannot ride along with a real edit |
| F5 | control: `/mailer/test` still writes the hash, via `_updateSettings` | **200**, row present, and equal to `configHash(settings, password)` |

F5 is what keeps F3/F4 from being a change that merely breaks the feature. The
guarantee is precisely *"no request body can set this label"* — not *"only one
function writes it"*, since `_updateSettings` bypasses the key filter as five
other call sites already do. The code comment states that distinction rather than
letting a reader assume the stronger one.

Why this mattered: the HMAC is keyed on `SIG_KEY`, so a hash lifted from a
staging instance sharing that key would verify here. The gate could be handed its
own answer.

## Mutation

| mutant | result |
|---|---|
| `/mailer/test` discards the hash-write return (the reported bug) | **1 failed** |
| `/mailer/settings` discards the settings-write return | **2 failed** |
| `smtp_verified_hash` back in `supportedFields` | **2 failed** |

The third needed care to write: `protectedFields` only refuses a key that is
**also** absent from `supportedFields`, so deleting the `protectedFields` entry
alone changes nothing observable — the label is refused as `unknown_keys`
instead, and the tests still pass. Adding it back to `supportedFields` is the
mutation that actually reopens the hole, and that one dies.

Worth stating because it is a real property of the guard: a key is protected by
being in one list and absent from the other, and only the pair expresses the
rule.

## Also verified unchanged

`/mailer/test`'s rate limit still refuses past its ceiling of six
(`200,200,200,429,429,429,429,429` over eight requests). The earlier nit — that
no test drives it past the ceiling — is unaffected by this hotfix and remains
open.

## Suites

`__tests__/security/notifications`: **86/86**.
