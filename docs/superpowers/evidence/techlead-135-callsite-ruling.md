# Techlead-1 — #135: where the cleanup goes, and the #138 permission checklist

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
privilege escalation via residual authority, actor provenance, audit integrity.
`infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout (read-only).

---

## (1) **Per-route call to the shared `offboardUser`. Not inside `User.delete`.**

TL-2's actor argument is the decisive one and it is stronger than "different actors": measured,
**one of the three sites has no actor to pass, and a second has one of a different kind.**

- `endpoints/admin.js:182` — a session route with `response.locals.actor` and a `validCanModify` check above it. A real user principal.
- `endpoints/api/admin/index.js:275` — an **API-key** route. `validApiKey.js:160` sets `response.locals.apiKeyContext`, not `locals.actor`; there is no user principal, and the key's own principal is what `keyGrantPrincipal` resolves.
- `endpoints/system.js:1261` — the `/system/enable-multi-user` **rollback**, `User.delete({})` with an empty clause, inside a `catch`. There is no actor at all: the operation that would have created one is the operation that just failed.

`User.delete` takes a **`clause`**, not a user id (`models/user.js:456`), and its whole body is a
`deleteMany` over that clause. Putting the cleanup there forces the model to invent an actor for
callers that do not have one — and `offboardUser` refuses a missing actor by design (F11, and
`requireActor` is the first line). A model-layer default actor would be exactly the free pass
every gateway entry point in this codebase declines to give, and it would write
`grant_revocations` rows naming a principal who performed nothing.

**So: each route resolves its own actor and calls `offboardUser` before `User.delete`.** That also
keeps #135 scoped as I ruled in `5f051a2a8` — *"route every deletion through the repository's
offboard path"* — rather than growing a second implementation.

**The third site is the exception and needs its own shape, not a per-id loop.** `User.delete({})`
deletes *every* user because every user was created moments earlier by the failed operation.
Enumerating ids to offboard each adds a query per user to a path that is already failing. My
`5f051a2a8` ruling (4) stands: truncate user-principal authorization rows once, with one bump, in
that same operation — and **that path must bump the policy version, which it does not today.**

QA-2's P5 model-layer discriminator is the right guard on this decision:

```
RF-P5 : User.delete called DIRECTLY (bypassing the route) leaves the authorization
        rows behind — asserted, not lamented
mut   : move the cleanup into User.delete
why   : if the cleanup lives in the model, this test is impossible to write and the
        route-level RFs are all green either way. It is the assertion that pins WHERE
        the cleanup lives, and it is the one a future refactor will trip.
```

Pair it with a route-level RF per site, or the two API routes drift apart the way the two delete
implementations would have.

---

## (2) `#138` permission-slice checklist, pre-written

When Dev3's SHA lands I check these, in this order:

1. **Seed vocabulary.** `directory.sync` reaches `ALL_ACTIONS` (via a category constant, the `AUDIT_ACTIONS` shape). Verify by running, not reading: `ALL_ACTIONS.includes("directory.sync")` and `ALL_ACTIONS.length === 64`. `super_admin.permissions === ALL_ACTIONS` is an identity, so this is also how super_admin gets it — confirm that identity still holds.
2. **Explicit migration grant row.** The `20260902020000` CROSS JOIN covers permissions existing *then*; a new row needs its own `super_admin` grant or the endpoint is gated on an action nobody holds — dead for everyone, the #63 shape.
3. **Both build paths agree.** Re-derive the migrated vocabulary from every `migration.sql` minus the retired set and compare to `ALL_ACTIONS` as sets, both directions — the check that caught #137's `audit.purge`.
4. **`vocabulary-diff.test.js` pin 63 → 64**, updated not removed, with the action's reason in the approved list. It is the only count pin; I swept the other six `ALL_ACTIONS` readers for #137 and they assert membership or inequalities.
5. **Timestamp** strictly greater than `20260902140000` and not colliding with an existing prefix.
6. **`setup_admin` deny WITH a `super_admin` allow control, in the same test.** "Denied" alone is satisfied by an action granted to nobody. And the deny must be asked of the **engine**, not read out of the seed array.
7. **`ORG_CAPABILITIES`** — only if the UI gates anything on it. If the sync-now button is gated client-side, `directory.sync` must be in that list or `can()` returns undefined and the button vanishes for `super_admin` too. If nothing is gated client-side, it must **not** be added — the list is deliberately fixed.
8. **No new grant to any other role**, verified by running the seed's role list rather than by reading the migration.
