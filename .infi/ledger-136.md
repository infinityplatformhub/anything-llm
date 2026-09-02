# Ledger — #136 (S12 slice 1: offboarding is a terminal state)

auth tier. Files: `server/models/user.js`, `server/endpoints/admin.js`,
`server/utils/http/index.js`, `server/__tests__/security/authorization/offboardUser.test.js`,
`server/__tests__/security/authorization/routeGateSweep.test.js`.

**`policyRepository.js` is NOT touched.** #134 (Dev3) owns it.

## Rulings

Ruling: `revokedAt` is set in the SAME transaction as `suspended`. A crash between two separate
writes leaves an account that is suspended in the UI and still usable by its API key — the worst of
the two states, and the one nobody would think to check. `User.update` already had the precedent: a
role change moves the legacy grant with it. — ถ้าผิด: บัญชีที่ "ถูกระงับแล้ว" แต่ key ยังใช้ได้ โดย
ไม่มีใครรู้

Ruling: revocation filters on `revokedAt: null`. An already-revoked key keeps its ORIGINAL
timestamp, because when a key stopped working is audit history — re-stamping it rewrites the record.

Ruling: browser-extension keys get no equivalent write. `validBrowserExtensionApiKey.js:27` re-reads
`suspended` on every request, and that key table has a real foreign key to `users`, so both the
suspend and the delete cases are already closed. Measured, not assumed.

Ruling: the endpoint is gated by `user.manage`, not a new `group.*` action. No `group.*` permission
is seeded — measured, the table holds `user.manage`, `user.read`, `user.write` — and inventing one
here would add a permission row with a single call site. Recorded as a residual instead.

Ruling REVERSED by TL-2 — the policy-version bump is NOT in this slice. I proposed exporting
`bumpVersion` (option ก) as the smallest change. TL-2 rejected it with a reason I had not measured:
an outside caller passing a bare `SCOPE_KEY(1)` bumps successfully, but `cache.invalidateScopes`
drops only exact-scope entries, so a suspended user's WORKSPACE-scoped cache entries survive. The
bump belongs to an `offboardUser` inside `policyRepository`, which is #134's lane until it merges.
The two tests for it were written and CONFIRMED RED on `941aa79e8` (version 13 before, 13 after),
then removed and replaced by a comment block naming what is missing and why. They return with the
`offboardUser` slice, with TL-2's required fixture: the assertion is that the user's
workspace-scoped entries are actually invalidated, observed through `cache.invalidateScopes`
behaviour, never through "bumpVersion was called". — ถ้าผิด: slice นี้จะอ้างว่าเพิกถอนสิทธิ์ครบ
ทั้งที่ cache ระดับ workspace ยังค้าง

Ruling REVERSED by TL-2 — `change_type: "suspension"` is dropped. `change_type` answers WHAT
changed (`grant`, `document_acl`, `group_membership`, `visibility`); WHY it changed belongs to the
audit event. My test asserted the new value; the assertion is gone with it.

Ruling: the JWT residual goes in `makeJWT`'s JSDoc rather than a ledger line alone. The next person
to read that function is the one who might trust a token without re-reading the user row, and a
30-day unrevocable window is not visible from the signature.

## Residuals

- **`document_acl` rows survive suspension.** Safe TODAY because `actorResolver` returns `null` for
  a suspended user before any ACL is consulted; it stops being safe the moment anything answers an
  ACL question without the resolver. Cleanup is #135. **This slice does not claim to revoke access
  completely.**
- **No `user.offboard` action.** One call site does not justify a permission row and a migration.
- **JWTs cannot be revoked.** 30-day default, no session table, no denylist, no `jti`. S13.

## Evidence

`npx jest __tests__/security/authorization/offboardUser.test.js` → **7 passed**.
`routeGateSweep.test.js` → **33 passed**, pinned count 318 → 319 with the reason in the comment.

RED against `941aa79e8` before the change: the key test (a suspended user's key authenticated —
`next()` called, no status), the endpoint test (route does not exist), and the two version tests
now deferred.

### Mutations, each named at the test it takes red (§7.9f)

| mutation | test that goes red |
|---|---|
| do not revoke at all | `refuses the key at the middleware, not merely in the column` |
| revoke every key, unfiltered by user | `CONTROL: an active user's key still authenticates` |
| revoke OUTSIDE the transaction | `ATOMICITY: if revocation fails, the suspension does not land either` |
| drop `user.manage` from the new route | `every mounted mutating route has identity-verified authorization`, `no mutating route carries validatedRequest alone` |
| relax `isConfirmedSingleUser` to "exactly one user" | `returns false as soon as ANY user row exists` |

**The atomicity mutation SURVIVED at first**, and that is the finding worth keeping. Moving the
revoke outside the transaction left all six other tests green, because every one of them observes
the END state of a call that succeeds — and both orderings reach the same end state when nothing
fails. What separates them is a failure BETWEEN the two writes, so the test induces one. Without
it, "in the same transaction" was a claim in a comment with nothing behind it.

## Full-suite result

`yarn test` on a freshly migrated and seeded database: **3276 passed, 1 failed, 36 skipped**
(224 suites passed, 1 failed).

The one failure is `__tests__/api/boundKeyDocumentsHttp.test.js` — `socket hang up` in
`Q41-2: a bound key sees only its own documents in the folder`. Run alone it is **35/35**. It is a
transport failure under full-suite load, in a file this change does not touch and on a path that
has nothing to do with offboarding: no assertion failed, the connection dropped. Reported rather
than re-run until green.

## Baseline note

The first full-suite run reported 29 failures. They were environmental, not this change: the run
used a scratch database that had never been migrated, and the failures are all
`The table \`public.<x>\` does not exist`. Re-run on a freshly migrated and seeded database before
any claim about the suite — a red run whose cause is the harness says nothing about the diff, and
reporting it as a result would be worse than not running it.

## Two fixture defects found in my own tests

Both produced a confident wrong answer before being fixed, and neither announced itself:

- the first key test set `suspended` with a raw `prisma.users.update`, **bypassing the code under
  test entirely**. It stayed red after a correct implementation, and I looked for the fault in the
  implementation before finding it in the fixture. It now goes through `User.update`, with an
  intermediate assertion on `revokedAt` so a failure says which half is wrong.
- the atomicity test first induced its failure with `jest.spyOn(prisma.api_keys, "updateMany")`.
  That spy never fires: the write happens on the TRANSACTION client, a different object. The mock
  silently did nothing and the test reported the code broken when the fixture was. It now uses
  `prisma.$use`, which runs for every client derived from the shared one.
