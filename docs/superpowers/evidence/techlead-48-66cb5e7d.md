# Techlead review — #48 `66cb5e7d` (credential clear, round 4)

**Verdict: PASS.** BLOCKER-1 is closed, and closed with the two things I asked for
together — the denylist *and* the test that would have caught it. My NIT-1 (key shape and
reflection) is closed. One thing landed that neither of us asked for and is right (NIT-3).
Two notes, no findings.

This supersedes my `techlead-48-06965da4.md` PASS, which was wrong. See §Retraction.

## Retraction — what I got wrong on `06965da4`

I verified that `KEY_MAPPING` is a closed allowlist: 91 `secret: true` entries, no duplicate
`envKey`s, none shared with a non-secret entry. That was correct, and I stopped there — I
concluded "not a way to unset arbitrary env vars" without asking the next question, **which
91**. `AUTH_TOKEN` and `JWT_SECRET` are both in it.

The specific error is worth naming because it is reusable: I checked that the gate was
*closed* and never checked what was *inside* it. An allowlist is only as good as its
membership rule, and `secret: true` answers "must not be written to `.env` in plaintext" —
a different question from "safe to unset".

**And the round-3 test suite was green for the wrong reason**, which is why reading it did
not correct me. `it.each(["STORAGE_DIR", "JWT_SECRET", "DATABASE_URL", "SIG_KEY"])` expected
400 and got 400 — but `JWT_SECRET` was not refused by the KEY_MAPPING check (it passes it).
It got 400 because `CredentialStore.delete` returns `false` when no row exists. The test
that should have caught the blocker was asserting the right outcome via the wrong mechanism,
and would have flipped to a real clear the moment a row existed. §7.9 again: the failure
mode is a test whose green tells you nothing about the code path you think it covers.

## BLOCKER-1 — closed

`INSTANCE_AUTH_KEYS` (`updateENV.js:1832-1838`) is checked **before** the KEY_MAPPING
membership test, so a denylisted key never reaches the credential-key branch.

The five entries are the right five, and the comment separates them correctly: `AUTH_TOKEN`
and `JWT_SECRET` are in KEY_MAPPING today and would otherwise be clearable; `SIG_KEY`,
`SIG_SALT` and `API_KEY_PEPPER` are not mapped and are already refused — listed anyway
because the harm is total (SIG_KEY/SIG_SALT derive the credential store's own encryption,
API_KEY_PEPPER validates every API key) and, in the comment's words, *"a denylist that only
covers today's mapping is one PR away from being wrong."* That is the right reason to list a
key that is currently unreachable.

The `AUTH_TOKEN` mechanism, verified in source rather than taken from the report:
`validatedRequest.js:28-37` — in the single-user branch, `!process.env.AUTH_TOKEN ||
!process.env.JWT_SECRET` calls `next()` with no check at all. Clearing `AUTH_TOKEN` deletes
the row too, so `loadStoredCredentials()` does not restore it at boot: the instance stays
open across restarts. (Note that `validatedRequest` reaches that branch only when
`isConfirmedSingleUser()` is true — so the exposure is single-user instances, which is
exactly the deployment shape most likely to have one operator and no second pair of eyes.)

## The four things PMO asked

### 1. Denylist — 5 keys

Present, ordered before the allowlist check, and exported so the test can iterate it rather
than restate it. Refusal message names the alternative (`/system/update-password`) instead
of just refusing.

### 2. `set-row-then-refuse`, not `no-row`

This is the fix to my round-3 blind spot and it is done properly. Each case
`CredentialStore.set(key, canary)` **first**, then asserts after the refusal that
`CredentialStore.get(key) === canary` **and** `process.env[key]` is unchanged — so neither
half of the clear ran, and the only thing that can explain the 400 is the denylist.

Two details in that test I want on record because they are the kind of thing that gets
"simplified" later:

- **`SIG_KEY`'s live value is deliberately not overwritten.** `SIG_KEY` derives the store's
  own encryption key, so assigning a canary to `process.env.SIG_KEY` would make the row
  written a moment earlier undecryptable — the test would fail on its own fixture and read
  as a broken denylist. The comment says exactly this.
- **Each case restores what it found.** `JWT_SECRET` and `AUTH_TOKEN` are the suite's own
  authentication; leaving them unset breaks every later test with "Cannot create JWT" — a
  fixture that takes the harness down looks identical to the code being broken.

`the instance stays authenticated after a refused clear` asserts the *consequence* end to
end: after a refused `AUTH_TOKEN` clear, an unauthenticated `POST /system/update-env` is
still 401. That is the assertion that survives a refactor of the denylist into something
else, because it tests the property rather than the mechanism.

### 3. Sweep: passthrough condition vs `secret: true` keys

`no secret:true key outside the denylist appears in the passthrough condition` is the
generalisation, and it is the most valuable test in the commit. It reads
`validatedRequest.js`, extracts the env names inside the passthrough condition, and asserts
no un-denylisted `secret: true` key is among them.

It guards the *class*, not today's two: if a future `secret: true` key is ever named in that
condition without being denylisted, this fails instead of the hole reopening silently. And
it carries an anti-vacuous guard — `expect(namedInCondition.size).toBeGreaterThan(0)` — so a
regex that stops matching fails loudly rather than passing on an empty set. That guard is
the difference between this test and a decorative one; source-scanning tests fail open by
default.

`the two that ARE mapped would otherwise be clearable` pins *why* the denylist is
load-bearing rather than belt-and-braces. Without it, someone tidying the list in a year
sees five entries and no evidence any of them does anything.

`every denylisted key is well-formed` catches a misspelled entry, which protects nothing and
looks identical to a correct one.

### 4. `envKey` shape, not reflected

`ENV_KEY_PATTERN = /^[A-Z0-9_]{1,64}$/`, checked first, before the name is scanned or echoed
anywhere. The rejection is a constant string — `"Invalid credential key."` — for every
malformed key, so it neither reflects caller input nor says which spellings get further.
Cases cover lowercase, a path segment (`..%2Fetc%2Fpasswd`), punctuation, and 65 characters.

Note the two refusals below it still name the key (`` `${envKey} is not a stored credential.` ``).
That is fine and I would not change it: by then the name has passed
`^[A-Z0-9_]{1,64}$`, so what is echoed is bounded, uppercase-alphanumeric, and reaches only
an authenticated `settings.write` holder.

## NIT-3 — not asked for, and right

`system.js:373-388`: `bcrypt.hashSync(undefined, 10)` throws, so an instance with no
`AUTH_TOKEN` answered **500** to a login attempt. Now the same 401 and `[003]` body as a
wrong password.

Two reasons this is a real fix rather than tidying, both stated in the comment: a 500 tells
an unauthenticated caller "something broke here", which is more than a failed login should
reveal; and it is not true — nothing broke, there is simply no password to match. It also
composes with the denylist: `AUTH_TOKEN` can still be absent for reasons other than a clear
(a fresh container, a dropped env), and now that path is a clean refusal.

## NOTE-A (carried from round 3, still open) — `.env` can outlive the clear

Unchanged and still out of scope. `dumpENV`'s `protectedKeys` excludes every `secret: true`
entry, so a dump cannot rewrite a cleared credential back. The residue is a `.env` file that
already contains one and is never rewritten: `dotenv` at `index.js:2-3` loads it at boot,
before `loadStoredCredentials`, and "already set wins" means the store is never consulted.

Pre-existing, but an operator revoking a leaked key on an instance upgraded from an older
version should be told to check `.env`. One line in the operator note for this feature.

## NOTE-B (carried, unchanged) — no `postUpdate` hooks on clear

Still zero of the 91 `secret: true` entries declare `postUpdate`/`postSettled`, so nothing
is skipped today. Recorded because the asymmetry is invisible: a hook added to a credential
key expecting to run on any change will not run here.

## Also verified

- Row → env ordering unchanged and still correct: a failed row delete leaves the live value
  in place and reports `cleared: false`, rather than breaking the provider now and restoring
  the credential at next boot.
- The route is still session-only. `[validatedRequest, requirePermission("settings.write", orgResource)]`,
  no `validApiKey` in the chain, `ROUTE_SCOPES` untouched, one grep hit for the path. An API
  key cannot reach it.
- The audit event still carries the key name and never the value, asserted both ways.
- `INSTANCE_AUTH_KEYS` and `ENV_KEY_PATTERN` are exported, so the tests iterate the real
  constants instead of a copy that can drift.
