# Techlead review — #48 `06965da4` (credential clear/revoke)

**Verdict: PASS**, two nits and one note. No blockers.

## The three things PMO asked

### 1. Is adding `envKey` to the redaction ALLOWED_KEYS safe — does the route reject anything outside KEY_MAPPING *before* the audit write?

**Yes, and the ordering is the reason it is safe.** `system.js:667-672`:

```js
const { cleared, error } = await clearStoredCredential(envKey);
if (!cleared) return response.status(400).json({ cleared, error });
await emitAuditEvent("credential_cleared", { envKey }, ...);
```

`clearStoredCredential` refuses first (`updateENV.js:1846-1852`) on
`Object.values(KEY_MAPPING).some(v => v.secret === true && v.envKey === envKey)`, so
`emitAuditEvent` is unreachable for any key that is not one of the 91 `secret: true`
entries. The value landing in the audit row is therefore drawn from a fixed 91-element set
defined in source, never from caller free text.

Verified the set rather than trusting the count: 91 `secret: true` entries, **no duplicate
`envKey`s**, and **no `envKey` shared with a non-secret entry** — so the allowlist
membership test cannot be satisfied by a differently-classified setting wearing the same env
name.

The allowlist entry is also the right *kind* of key for this module. `ALLOWED_KEYS` exists
because a key being permitted says nothing about what a user typed into it; `envKey` is the
rare case where the value provably cannot be user-typed. The comment says exactly that,
which is what a future reader needs — the risk is not this entry, it is the next one added
by analogy.

One thing worth stating plainly: the second guard still runs. `envKey` values go through the
pattern scan like everything else, and none of the 91 names match a PDPA pattern, so nothing
is scrubbed. Being allowlisted is not an exemption from scanning.

### 2. Row → env ordering

**Correct, and the reasoning in the comment is the reasoning I would want.**
`updateENV.js:1862-1869`: `CredentialStore.delete()` first; only on success is
`delete process.env[envKey]` executed.

The failure mode this ordering picks is the right one. Reverse it and a failed row delete
leaves the process without the credential while the row survives — the provider breaks *now*
and the credential comes back at the next boot via `loadStoredCredentials()`, which is both
an outage and a false revocation. As written, a failed delete leaves the system exactly as
it was and tells the caller `cleared: false`.

Both halves are genuinely necessary and both are tested:
- row only → `loadStoredCredentials()` restores it next boot (`and it does not come back on
  the next boot`);
- env only → the provider keeps working until restart while the operator has been told it is
  revoked (`unsets the live value, so the provider stops working now`).

`CredentialStore.delete` returns `false` rather than throwing when no row exists, so clearing
an already-absent credential is a 400 — asserted, and correct: a 200 there reads as "it is
gone" whether or not it ever was.

### 3. Is the permission session-only — does it leak to `/v1`?

**Session-only. It does not reach `/v1`.**

- The route is registered by `systemEndpoints`, mounted under `/api`, so its path is
  `/api/system/credential/:envKey`. Nothing under `/v1`.
- `git grep '"/system/credential'` on this SHA returns exactly one hit — the route
  definition. No API-key surface duplicates it.
- Its middleware is `[validatedRequest, requirePermission("settings.write", orgResource)]` —
  the session path. `validApiKey` is not in the chain, so an API key cannot reach it at all.
- `ROUTE_SCOPES` is unchanged by this commit: no `DELETE /v1/system/credential/...` entry,
  and `scopeFor` returning undefined is how `/v1` refuses unmapped routes. There is no scope
  that grants this.

Consistent with the existing line at `scopes.js:112` — reading the provider credentials is
deliberately outside the API-key surface, and revoking them stays outside it too.

## Tests

The suite tests the right claims, and two of them are the ones I would have asked for:

- **The premise is asserted, not assumed.** `the validator refuses '' before the delete
  branch is reachable` proves the gap this issue exists to close, and `force does not bypass
  it either` calls the validators directly with `force = true` rather than reasoning about
  them. If a future change makes empty values acceptable, these fail and someone re-examines
  whether the route is still needed. That is the correct way to pin a premise.
- **The refusal list names the keys that matter**: `STORAGE_DIR`, `JWT_SECRET`,
  `DATABASE_URL`, `SIG_KEY`, each asserted to stay set. Without the KEY_MAPPING check this
  route is a way to unset arbitrary process env vars over HTTP, and the test says so.
- **403 and 401 both assert the credential is untouched**, not merely that the response was
  refused. That is the difference between testing the gate and testing the outcome.
- **The audit test asserts both directions**: the row contains the key name and does *not*
  contain the secret.
- Real database, real encrypted row, real `loadStoredCredentials()` — correct for a claim
  about what survives a restart, which a mocked store cannot answer.

## NIT-1 (low) — the route has no rate limit or `:envKey` shape guard

Every other sensitive route in `system.js` carries one (`loginIpRateLimit`,
`inviteRateLimit`). This one is behind `settings.write`, so the caller is already an
authenticated admin and the blast radius is self-inflicted — but the path parameter is
unvalidated free text that reaches a `Object.values(...).some()` scan and, on the 400 path,
is echoed back in the error message (`` `${envKey} is not a stored credential.` ``). That is
a reflection of caller input into a response body. Harmless as JSON to an authenticated
admin; worth a `String(envKey).slice(0, 64)` or a character-class check so it cannot be long
or exotic.

## NIT-2 (low) — no `postUpdate` hooks run on clear

`updateENV` runs `postUpdate` / `postSettled` hooks after changing a value;
`clearStoredCredential` runs none. I checked whether that matters: **zero of the 91
`secret: true` entries declare `postUpdate` or `postSettled`**, so today nothing is skipped.
Recording it because the asymmetry is invisible — the day someone adds a hook to a credential
key expecting it to run on any change, it will not run here.

## NOTE — `dumpENV` cannot undo the clear

Confirmed benign, but it is the question a reviewer should ask. `dumpENV`'s `protectedKeys`
excludes every `secret: true` entry (`updateENV.js:1883-1890`), so a `dumpENV()` after a
clear cannot write the revoked value back to `.env`. And because it rebuilds the file from
`protectedKeys` rather than editing in place, a value written to `.env` *before* P0-4D(c)
would be dropped on the next dump rather than preserved.

The one residue is a `.env` file that already contains the credential and is never rewritten:
`dotenv` at `index.js:2-3` reloads it at the next boot, before `loadStoredCredentials` runs,
and the "already set wins" rule means the store is not consulted. Pre-existing and outside
#48's scope — but an operator revoking a leaked key on a deployment upgraded from an older
version should be told to check `.env`. Worth one line in the operator-facing note for this
feature, if there is one.

## Also verified

- `boundKeyDocumentsHttp.test.js` picks up two #41 NIT-1 tests in this commit: the join
  failing closed for a bound key, and the same failure *not* restricting an unbound key. Both
  directions, correctly — the second is what stops "fail closed" from becoming "fail closed
  for everyone".
- The audit event carries `response?.locals?.user?.id` as the actor, so the row names who
  revoked it.
- The 400 body shape (`{cleared, error}`) matches the 200 body shape, so a caller parses one
  thing.
