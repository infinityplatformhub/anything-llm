# ledger — #116 update-password credential rollback

Branch `approof/116-rollback`, base `2e6ee3294`. Recon: `.infi/recon/recon-116.md`.
Carries two #108 follow-ups (QA-1 + TL-2 NITs) because the frontend lane was free.

---

## Rulings

Ruling: compensate in the **store only**, not with a transaction and not two-phase. The defect
is that the STORE ends up holding one new value and one old; `process.env` is already running on
both new values and is not the problem. A transaction would have to live inside `updateENV`,
which 213 settings share — putting a property of this route's pair into a function everything
uses, a shape #84 already refused. If wrong: a compensation can fail where a transaction could
not, which RF-4 covers by reporting rather than throwing.

Ruling: prior values are read from **`CredentialStore.get` before `updateENV`**, never from
`process.env`. Two bugs closed by one rule — `updateENV` overwrites `process.env.JWT_SECRET`
before compensation runs, so an env-sourced read would capture the NEW secret and "restore" it;
and during #115's hydrate window the environment is empty while the store is not, so an
env-sourced read would restore an absence over a real row. Asserted with a fixture whose env
values differ from the store's on purpose.

Ruling: **`process.env` is NOT rolled back** (RF-5, pinned by a test). QA-3 asked for it; the
ruling is #104's and it wins. This process is already serving requests on the new values —
unsetting them logs the operator out of the session they are making the change from and breaks
every request in flight, on top of the credential still being lost at the next restart. Store
rollback fixes durability; env rollback would break the present to tidy the past. The tension is
recorded here rather than resolved silently: a future contributor adding an env rollback "for
symmetry" fails RF-5 and finds this paragraph.

Ruling: restoring a prior ABSENCE is a `delete`, not `set(key, "")`. `CredentialStore.set`
refuses an empty value ("a credential must have a value; delete the row to clear it"), so the
write would fail and leave the row it meant to remove. Mutation-verified: replacing the branch
with `set(previous ?? "")` fails RF-2b and the absent-row pair.

Ruling: `JWTSecret` is passed **before** `AuthToken`. `updateENV` iterates in key order and a
failing store usually fails on the FIRST write, so this order makes the common failure
"JWT_SECRET lost, AUTH_TOKEN stored" — which the next boot repairs, since `ensure-secrets`
regenerates JWT_SECRET — rather than the reverse, which leaves AUTH_TOKEN absent and the
instance open. This is NOT the protection; the compensation is, and it makes the order stop
mattering. It costs nothing and improves the window before compensation runs.

Ruling: `__tests__/api/updateEnvUnknownKeysHttp.test.js` (from #91) is **edited, not worked
around**. It pinned the `updateENV` call as one ordered literal, so the reorder above broke it.
Its subject is that the key set is FIXED and not caller-controlled — order is incidental — so it
now asserts each key independently plus "exactly these two names appear", which preserves the
intent and stops it reading a safety improvement as a regression. Editing another issue's test
is flagged rather than quiet: PMO confirmed the reading before it stood.

## The finding this issue did not name

`validatedRequest.js:29-36` is a **disjunction**: `!AUTH_TOKEN || !JWT_SECRET` → passthrough, no
auth. `ensure-secrets.js` regenerates JWT_SECRET at boot but deliberately NOT AUTH_TOKEN
(random bytes there is a permanent lockout, `ensure-secrets.js:9-19`). So a store left holding
only JWT_SECRET comes up on the next boot with **no password at all**, while the operator
believes they just set one. The reverse order is benign.

Restore-to-absent closes it: the instance returns to its pre-password state.

## Residual, stated exactly

Restore-to-absent returns the instance to the state it was in before a password was ever set,
which `validatedRequest` treats as passthrough — **deliberately and knowingly**
(`ensure-secrets.js:22-26`). That is not a new hole opened by this change: it is where the
operator already was. What changes is that they now get `success: false` naming the credential,
instead of believing the change succeeded.

## Correction — one of my own tests was fake, and mutation caught it

The #108 hostile-response test I wrote passed, and then **passed again with the vulnerable code
restored**. Reverting the page to the old `{...stored}` spread left it green, because the
injected keys (`smtp_password`, `password`) are rendered by no field — "not in `innerHTML`" was
true either way. It asserted a leak in a place the leak could not appear.

Rewritten to assert what a spread actually does: an unknown key reaching form STATE and riding
along in the POST body, where it is invisible on screen. Mutation now kills it.

The class, for §7.17: **a hostile-input test must place its payload where the vulnerable path
would actually carry it** — not merely somewhere plausible. This is the same family as #94's
dotted host, #49's twin stamps and #108's loader-wait, with the distinction that this one was
self-inflicted and caught only because the mutant was run.

QA-1's related finding is fixed at the source: the page now PICKS the keys in `BLANK` rather
than spreading everything except `hasPassword`. Allow-by-default became deny-by-default, so a
secret-bearing field added to that endpoint later is dropped rather than landed in the form.

## Mutation — each caught by a distinct test

| mutant | caught by |
|---|---|
| drop the restore | RF-1, RF-2, RF-4, absent-row pair (5) |
| read prior values AFTER `updateENV` | RF-2 outcome AND RF-2 ordering |
| restore unconditionally | RF-3 only |
| `set(previous ?? "")` instead of `delete` | RF-2b + absent-row pair |
| swap the mailer route to `ManagerRoute` (#108) | the new `main.jsx` source assertion |
| revert the pick to a spread (#108) | the rewritten hostile test |

## Note

The route-source assertions read `main.jsx` and `system.js` as text rather than importing them:
importing `main.jsx` executes the app entry point and mounts every page, and importing
`system.js` to inspect a route body is not possible at all.
