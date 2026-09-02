# QA-3 evidence — #77 `df5fcc95` — PASS

Author: QA-3 (anything-llm-ea). Worktree `/tmp/qa3-77`, own database `qa3_77`
(PostgreSQL 17, `en_US.UTF-8`), own `yarn install` + `prisma generate`. Probes are
independently written, not Dev3's tests re-run.

## The RED I reported is green, and green for the right reason

```
P1 statuses=200,200,200,200,200,429
```

Set `LOGIN_ACCOUNT_RATE_LIMIT_MAX=2`, require the module, raise it to `5`, then
send six requests. Five are served and **the sixth is refused**. The refusal
matters as much as the five: it proves the new ceiling is being enforced, not
that the limiter stopped counting.

Measured before the fix, for contrast: `200,200,429,429,429` — refused on the
third, against the frozen `2`.

## Every limiter reads late, not only the two Dev3 covered

Dev3's tests exercise `inviteRateLimit` and `loginAccountRateLimit`. The fix is
inside `limiter()`, so it should reach all seven, but that is an argument rather
than a measurement. Measured:

```
P2 chatSearchRateLimit:   at limit=1 -> 200,429; after raising to 50 -> 200
P2 embedHistoryRateLimit: at limit=1 -> 200,429; after raising to 50 -> 200
P2 loginIpRateLimit:      at limit=1 -> 200,429; after raising to 50 -> 200
```

## `windowMs` is frozen, as ruled

```
P3 after shrinking INVITE_RATE_LIMIT_WINDOW_MS to 1ms and waiting 30ms -> 429
```

The entry does not expire early, so the window in force is still the one captured
at `init()`. This is the ruled behaviour, asserted rather than assumed: a reader
should be able to see that the asymmetry between `limit` and `windowMs` is
deliberate and holds.

## Reading late does not open a hole

| input | result |
|---|---|
| `"not-a-number"` | 30 served, 1 refused over 31 requests — falls back to the built-in default |
| `"0"` | 1 refused over 31 |
| `"-5"` | 1 refused over 31 |

A per-request read that turned a typo into an unlimited endpoint would be worse
than the bug it fixes. `integerEnv`'s `Number.isSafeInteger(value) && value > 0`
guard is what prevents it, and it still runs on every request.

## `resetRequestControls` still reaches the live store

```
P6 limit=1 -> 200, 429; await resetRequestControls(); -> 200
```

The fix could have been written to build a store per request, which would have
left `resetRequestControls` clearing an object nobody counts in — silently
breaking the `beforeEach` reset that several suites depend on. It was not.

## Mutation

| mutant | result |
|---|---|
| `limit: integerEnv(...)` — revert to frozen | **3 failed** (both of Dev3's directions, plus the QA-3 regression) |
| `requestControlStores.push(new BoundedMemoryStore())` — break store identity | **7 failed** across `requestControlsHttp` + `ldapRoutesHttp` |
| `limit: () => Number(process.env[limitEnv]) \|\| limit` — drop `integerEnv` | **survives, 7/7 still pass** |

The third is a real gap, and small: with `integerEnv` replaced by a bare
`Number(...) || fallback`, a limit of `-5` yields **0 served / 31 refused** where
the shipped code yields 30 served / 1 refused. A negative value would take the
endpoint offline instead of falling back. No test in the suite distinguishes the
two, because the fallback cases only exercise `"not-a-number"` and unset — both
of which `|| fallback` handles identically.

Not a blocker: the shipped code is correct, and the mutant is one nobody has
written. Worth one more case in the parametrized fallback test (`"0"`, `"-5"`) so
the guard that makes it correct is pinned.

## Suites

`requestControlsHttp` + `__tests__/security/identity` (23 suites): **308/308**.

Per §7.14 the full suite is the gate's single run, not QA's.

---

# Addendum — S11 mockup B on merge target `a004eee3`

`a004eee3` carries `docs/superpowers/mockups/s11-smtp-b-guided-setup.html` and
`recon/s11-smtp-mailer.md` alongside the #77 code, so merging #77 lands them too.
All three fixes QA-3 asked for are present and behave. Exercised by driving the
mockup's own script against a stub DOM — clicked, not read.

| fix | result |
|---|---|
| (1) plaintext needs explicit acceptance | `TLS=none`, Continue without ticking → **stays on step 1**, the blocked message appears. Tick the box → advances. |
| (1b) consent does not survive changing the choice | Back to step 1, switch to `tls` → `tls-accept` is **unchecked** again. |
| (3) reconfiguring invalidates the previous test | Test passes → save → Reconfigure → change host → Continue → the result panel still renders the OLD success text, so the stale "Save and turn on" button is still clickable — clicking it now yields **"Not saved. This configuration has not sent a message yet."** and stays on step 2. |
| (2) `verified` is read, not merely set | The refusal above is that read. Before the fix the same click would have saved the new host on the old host's evidence. |

Worth noting for whoever builds the real step: the stale success panel is still
on screen at the moment the refusal happens, so the operator sees a green
"Accepted by the server" box and a red "Not saved" box at once. The gate is
correct; the screen briefly contradicts itself. Clearing `#result` in the
`reconf` handler would close that, and costs nothing.

`recon/s11-smtp-mailer.md` §5b now states the part that matters most: the gate is
the **backend's**, the save endpoint must refuse a configuration with no
successful test bound to that exact config, and the binding is a hash over the
connection-determining fields — never the credential's value. The mockup's flag
is named as the visible half only. That is the right shape, and it is written
where the implementer will read it rather than left in a review thread.
