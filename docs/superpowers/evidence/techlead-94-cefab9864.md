# Techlead-1 — #94 O5b `cefab9864` (rebased from `6b47fa820`)

Reviewed `6b47fa820` in full, then confirmed the delta to `cefab9864`. Probes are in-process
`node -e` against the real modules in detached worktrees `/tmp/tl1-94` and `/tmp/tl1-94b`;
no suite run (§7.14).

**Verdict: PASS with one finding.** F1–F4 from my pre-read are all closed, and closed in the
way I asked rather than the way that would have looked the same. FINDING-1 below is a leak I
found by probing the path this SHA's own test opened, not a regression it introduced.

## The delta is what PMO said it is

`git diff 6b47fa820 cefab9864` restricted to `#94`'s own files is **one comment block** in
`bundle.test.js:130-142` — "red until the #95 hotfix lands" replaced by why the ID is seeded
into an event name and that it goes red again if #95 is reverted. Better: the old text would
have read as a stale TODO the moment #95 merged. No code changed in `diagnostics/index.js`,
`doctor.js`, or the entrypoint. Everything else in the range is #40/#84/#95/#96 landing.

The #95 half I did check, because the seeded assertion depends on it: numeric patterns moved
from `\b` to `(?<!\d)…(?!\d)`. Probed — `note_1234567890123` → `note_[redacted:thai_national_id]`,
`user_0812345678` → `user_[redacted:phone_th]`, 16-digit card still claimed whole by
`credit_card` (the reason the lookaround is on digits rather than absent), 12 and 17 digits
untouched. The bundle's seed scan is green on the rebase for the right reason.

## F1–F4 closed

**F1** — both helpers now exported (`redaction.js` + `updateENV.js`), and the tests hold the
*forbidden alternatives* rather than just asserting the exports exist:
`bundle.test.js:106` drives `redactEventData` on a bundle-shaped object and pins
`{_droppedKeyCount: 4}`; `:121` pins `maskSecretValues` returning `**********`. That is the
shape that survives a future refactor reaching for the wrong one.

**F2** — the self-satisfying assertion is gone and replaced by two that check what each list
claims. `secret === false`, not `!== true` — asked for, and the comment gives the reason
(`secret: "url"` is neither). Probed the four DERIVED keys against the real table: all
resolve, all `false`. `DATABASE_URL` is in neither list with its own `URL_SHAPED_KEYS` case,
and `ENV_ALLOWLIST` is asserted to be exactly the three lists composed — I mutated
`ENV_ALLOWLIST` by appending `"OPEN_AI_KEY"` directly and the composition test goes **RED**.

**F3a** — probed `String(os.totalmem())` in `collectResources`: the numbers test goes
**RED** on `typeof … === "number"`. Note the second assertion in that test
(`not.toContain("[redacted:")`) passed under the mutation, because this machine's
`totalmem()` is 11 digits, not 13 — the typeof assertion is the one doing the work, and it
is the one that is there.

**F3b** — mutated `collectEnv` to scrub before stripping: `DATABASE_URL` becomes
`**********` (the scrubbed string no longer parses as a URL) and the order test goes **RED**
on its exact-value assertion. The comment explaining what reversal would produce is slightly
off — it predicts `[redacted:email]@db.internal`, the measured result is a full mask — but
the test asserts the value, not the prediction, so it catches either.

**F4** — `collectDatabase` builds `connection` from `stripUrlCredentials` rather than
borrowing the doctor's `maskUrl`. Probed end to end: `postgresql://db.internal:5432/anythingllm`,
no `appuser`. The recon's "already redacted by construction" line is gone and `checks` now
passes through the same `scrubValue` as everything else. The seed-by-path test (`:361`) does
what I asked — the password arrives through a check's `detail`, not through `collectEnv` —
and asserts the 8-character prefix too.

Probed the whole thing once more on `cefab9864` with every marker seeded: **all five clean**.

## FINDING-1 — the check-detail path only redacts when the DB host contains a dot

The seed-by-path test proves a password in a `detail` string is removed. It is removed
because `scrubValue`'s **email** pattern matches `appuser:password@db.internal` — and that
pattern requires a dot in the host (`[\w.+-]+@[\w-]+\.[\w.]+`). The shipped Docker
`DATABASE_URL` has no dot in its host.

Measured on `cefab9864`, same password, same code path, only the host changed:

| `DATABASE_URL` host | password in bundle |
|---|---|
| `db.internal:5432` (the test's fixture) | clean |
| **`postgres:5432`** (`docker/docker-compose.yml:59`) | **LEAKS** |
| **`localhost:5432`** (`.github/workflows/ci.yml:72`) | **LEAKS** |

Both leaking hosts are the ones the project actually ships. The test fixture is the one
shape that happens to be caught.

Two live paths carry it:

1. **`checks`** — `db.reachable`'s detail is `` `Connected to ${maskUrl(databaseUrl)}` ``.
   `maskUrl` replaces the password with `****`, so this specific string is safe today; the
   exposure is any future or third-party check that quotes a URL unmasked, which is exactly
   what the seed-by-path test was written to defend against.
2. **`collectDatabase`'s error strings** — and this one is live now. `safeQuery` returns
   `error.message` verbatim into `migrations`, `serverVersion`, `counts.<table>` and
   `eventCounts`. Probed with a driver error quoting the connection string on a dotless
   host: the password appears in the bundle in full. A `pg` connection failure quoting the
   connection string is an ordinary thing for a driver to do, and an unreachable database is
   precisely when someone runs `--bundle`.

The password is also not fully removed even when the email pattern *does* fire — it eats
from the first `@`-adjacent run backwards, so `Xq7!kR2#mN9$vL4` leaves `Xq7!kR2#mN9$`
standing. The pattern is not a credential remover; it happens to overlap one.

**Fix, and it is small:** `collectDatabase` already knows the answer. Run every string it
returns through the same `stripUrlCredentials`-then-`scrubValue` order `collectEnv` uses —
one helper applied to `safeQuery`'s `error` and to each `checks[].detail`, replacing any
`scheme://user:pass@` run with its stripped form before `scrubValue` sees it. That closes
both paths at the source rather than relying on a pattern that was written for mailboxes.

Whether this blocks the merge is PMO's call. My read: it is a **real leak on the shipped
configuration**, but the bundle is CLI-only, is generated deliberately, and the message tells
the operator to read it before sharing. I would merge and fix it as a same-day follow-up
rather than hold the SHA — but the residual must say "a database driver error quoting a
dotless-host connection string carries its password into the bundle", not a softer version.
The test that comes with the fix should use `postgres:5432`, not `db.internal`.

## NIT-1 — `UNDECLARED_ENV_KEYS` has no denylist behind it

The two guard tests are exactly what I asked for and they hold their own lists honestly. But
`UNDECLARED` is, by construction, "keys the tree says nothing about", so its only real guard
is the reason string. I added `API_KEY_PEPPER` to it with a 20+ character justification and
**every assertion in the suite stayed green** while `collectEnv` returned the pepper.

Not a defect in this SHA — that is what "undeclared" means, and the reason strings are good.
But there are two denylists already in the tree that would catch it for free:
`REQUIRED_SECRETS` from `utils/doctor` (`JWT_SECRET`, `SIG_KEY`, `SIG_SALT`, `API_KEY_PEPPER`)
and the 122 envKeys `KEY_MAPPING` declares `secret: true` or `"url"`. One assertion —
`UNDECLARED ∩ (REQUIRED_SECRETS ∪ declaredSecretEnvKeys) === []` — costs three lines and
turns "someone must notice at review" into a test. Measured: the current allowlist's
intersection with both is empty, so it goes in green today.

## OBS-1 — CLI and entrypoint

`--bundle` writes to stdout exactly once (`doctor.js:108`); the checklist is switched to
`console.error` by a `say` binding; an unknown option exits 64 with empty stdout. The
entrypoint `shift`s and forwards `"$@"`, tested behaviourally with a stub `node` that
records argv rather than by reading the script. The exit code reports the checks, not the
bundling, with the reason written down. The second `pg` client is deliberate and explained.
No comment from me on any of it.
