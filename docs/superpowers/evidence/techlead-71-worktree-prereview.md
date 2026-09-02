# Techlead-1 — #71 invite-code leak, pre-SHA review of the `s3-ldap` working tree

Reviewed: uncommitted changes in `.claude/worktrees/s3-ldap` on top of `031be4f5` — `redaction.js`,
`auditRedaction.test.js`, `endpoints/admin.js`, `endpoints/api/admin/index.js`, plus untracked
`__tests__/api/inviteCodeAuditHttp.test.js` and migration `20260902110000_disable_pre_fix_invites`.
Read-only; nothing in that worktree was modified. Techlead-2's design review is
`techlead2-s11-leak-031be4f5.md`.

**All five spec items are implemented and the five original leak shapes are closed — I reproduced
each.** One finding: the pattern's leading `\b` leaves a bypass, and the test table cannot see it.

## The fix works, measured

Nine shapes through the fixed `redactEventData`, code from the real `Invite.makeCode()`:

```
A {inviteCode}                    blocked  dropped:["inviteCode"]
B {code}                          blocked  dropped:["code"]
C {changes:{code}}                blocked  redactions:["invite_code"]
D {link: ".../invite/<code>"}     blocked  redactions:["invite_code"]
E {inviteCode:{value}}            blocked  dropped:["inviteCode"]
F {name: "invite for bob <code>"} blocked  redactions:["invite_code"]
G {changes:{invites:[<code>]}}    blocked  redactions:["invite_code"]
H {workspaceName: <code>}         blocked  redactions:["invite_code"]
I {changes:{nested:{deep:[{c}]}}} blocked  redactions:["invite_code"]
```

All five TL-2 rows that leaked at `031be4f5` are closed, plus two I added (H, I).

**Two independent guards, and I confirmed each is load-bearing on its own:**

| mutant | result |
|---|---|
| pattern removed, key removal kept | **C, D, F, G leak** — TL-2's HOLE-1 exactly |
| `inviteCode` restored to `ALLOWED_KEYS`, pattern kept | no leaks |

So the pattern is what closes the class and the key removal is defence in depth, which is what the
comment in `redaction.js:67-79` claims. The claim is accurate.

**Bound of 16 rather than 43 is right, and the comment gives the right reason** — a bound tied to
today's length stops matching the moment the code gets shorter, failing open silently. Verified the
boundary: 15 chars kept, 16 redacted. No false positives on `apw-inv-short`, `apw-key-…`, or
`filename-apw-inv-notacode`.

**Pattern ordering** — placed last so the PDPA classes claim their matches first. Correct, and it
matters: an email-shaped string containing a code would otherwise be labelled `invite_code`.

## FINDING-1 (medium) — `\b` before `apw-inv-` is a bypass, and the test table cannot detect it

`/\bapw-inv-…/` requires a non-word character (or string start) before `apw`. A code concatenated
directly onto a word character escapes:

```
"x"      + code   LEAKS      "/" + code   blocked
"_"      + code   LEAKS      "=" + code   blocked
"id"     + code   LEAKS      "?code=" + code  blocked
"token"  + code   LEAKS      '{"c":"' + code  blocked
```

`_` leaks because underscore is a word character, so `\b` does not fire between `_` and `a`.

The realistic carrier is string interpolation without a separator — `` `token${code}` ``,
`` `invite${code}` ``, a snake_case key glued to a value, a filename like `invite_<code>.txt`. Not
exotic: it is the same class of shape as the `link` case TL-2 found, one character different.

**The test table cannot catch this.** `describe.each` runs two forms per key — the bare code, and
`` `invite ${code} was sent` `` — both of which have a space or string-start before `apw`. I ran the
glued form against the suite's own shapes: `name: "id" + code` leaks and no test asserts it.

Fix is to drop the `\b`:

```js
{ name: "invite_code", re: () => /apw-inv-[A-Za-z0-9_-]{16,}/g }
```

Verified this matches all four glued forms **and** still rejects every false positive above — the
`apw-inv-` literal is the discriminator, and the `\b` adds nothing it does not already have. Add one
row to the table: a third form per key, `` `token${code}` ``, so the property is pinned rather than
argued.

## The test table — enumerated, not hand-picked, and it kills the right mutant

`describe.each([...ALLOWED_KEYS].filter(k => k !== "changes"))` × 2 forms = **86 tests** over 43
keys. Deriving from the exported set rather than a fixed list means a key added later is covered the
day it is added, which is the property TL-2's HOLE-4 asked for.

I ran the table's logic against the pattern-removed mutant: **43 of 43 keys fail**. Against the real
module: 0 fail. So it is neither vacuous nor passing for the wrong reason.

`changes` correctly excluded from the loop and given its own case — it goes through `scrubChanges`, a
different function, so folding it into the table would exercise the wrong code path and leave half
the redaction code unproven. The comment says exactly this.

Two guards worth naming: the HTTP test asserts `typeof code === "string"` and `length > 20` before
searching for it (without that, a route that stopped returning a code would make every "not contains"
assertion pass against an empty string), and it scans **all 200 rows** rather than just the
`invite_created` row — the claim is that the credential is absent from the log, whichever event
carries it.

## HOLE-2 and HOLE-3, both closed as TL-2 specified

**`/v1/admin/invite/new`** now emits `api_invite_created` with `inviteId` and no `userId`, matching
`api_user_deleted`'s convention at `:260` — the actor is an API key, and claiming a user id it does
not have would be worse than recording none. Guarded with `if (invite)` so a failed create emits
nothing. The HTTP test asserts the **count increments through the real route** rather than that an
emit call exists in the source; those are different claims and the test makes the right one.

**Migration `110000`** bulk-disables `pending` invites. This is TL-2's cheaper path and the comment
carries the whole argument: redacting log rows does not revoke a code that has already been exported;
the audit log is append-only and `deleteAuditEvents` is its single sanctioned mutation path, so
editing history from a migration would set a precedent worth more than the tidiness it buys; the cost
(legitimately-issued pending invites stop working) is stated plainly rather than buried. `claimed`
and already-`disabled` rows untouched, so no existing account is affected. Slot 110000 is after
102000 and touches only `invites`, which nothing else in this branch alters.

## NIT-1 — the migration is unconditional, and there is no marker for a fresh install
A brand-new deployment running migrations from zero has no invites, so the `UPDATE` is a harmless
no-op. But an operator who runs `migrate deploy` on a database seeded moments earlier — or a test
fixture that creates invites before migrating — silently loses them. Not worth a guard on its own;
worth knowing that the migration's blast radius is "every pending invite at apply time", which the
comment says but the operator running it may not read.

## NIT-2 — `link` is documented as dormant, and now it is not
`redaction.js:73` calls `link` "the dormant `link` key". The HTTP-adjacent test `QA-3: the
accept-invite URL the frontend builds is redacted` points at `NewInviteModal/index.jsx:41,86`, which
composes exactly that URL for the clipboard. So `link` is one copy-paste from live, which strengthens
the case for the pattern rather than weakening anything — but "dormant" undersells it. One word.

## What I did not do
Did not run the suite (§7.14). Every table above comes from executing the real `redaction.js` and
`Invite.makeCode()` under node 22, including two recompiled mutants loaded in-process. The worktree
was read only — no file in it was written.
