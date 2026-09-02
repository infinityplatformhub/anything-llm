# Techlead-1 — #40 task 2 `36b110a8d`

Reviewed against my pre-read (`techlead-40-task2-preread.md`) and `approof/main`. Probes are
in-process `node -e` in detached worktree `/tmp/tl1-t2` against a live PostgreSQL
(`t1-authz-postgres-1`, real `workspaces`/`workspace_users`/`users` tables, rows seeded and
removed). Per §7.14 I did not run the suite; 30/30 is PMO's gate.

**Verdict: PASS.** Three answers to the questions asked, one correction, one NIT.

## Answer 1 — exporting `workspaceCapabilities` for testability: yes, and this is the good case

The seam is justified by the thing it makes reachable. `authorizeMany` throws only on a
scope mismatch, and — as I measured in the pre-read — **no action in either capability list
can produce one**: every permissions row defaults to `scope='any'` and the only non-`any`
action, `org.member`, is deliberately absent from `ORG_CAPABILITIES`. So nothing in a healthy
fixture can make the workspace batch throw, and an HTTP-only suite would assert "the org half
survives" against a path it never enters. The comment at `system.js:2004-2007` says exactly
this.

What makes it acceptable rather than a hole:

- The export is a **pure function taking its collaborators as arguments** — no state, no new
  branch in production code. `engine` was already a parameter of the split; the export adds
  nothing the endpoint does not already do.
- The two unit tests inject a **throwing engine**, i.e. they exercise the real `try/catch` in
  the real function. That is a seam, not a stub of the thing under test.
- The HTTP tests still cover every path a request can actually take. The unit pair covers
  only the two that a request cannot reach.

The alternative — asserting the catch by reading the source, or accepting a green test that
never enters the branch — is the shape this program keeps rejecting. I would rather have the
export.

One note for the ledger: `system.js:1567-1590` computes the org half **before** the workspace
half runs, so the split's guarantee is ordering plus a private catch, not the catch alone. If
someone later moves the workspace await above the org batch, both unit tests stay green and
the property is gone. Worth one line in the comment.

## Answer 2 — M4 must have its own test, and Dev2's stated reason for the weak result is wrong

PMO leans yes. I agree, and more strongly than the mutation table suggests, because the
explanation attached to it does not hold.

Dev2 recorded: *"M4 ลบ guard `!user?.id` → แดง 1/11 เท่านั้น (prisma undefined-in-some ไม่
match ไม่ใช่สัญญา)"* — i.e. only one test went red, and the reason offered is that Prisma does
not match on `some: {user_id: undefined}`.

**Measured against Prisma 5.3.1 on a real database, with a real member, a real stranger, and
a real workspace:**

```
some:{user_id: <member>}    -> {"id":1}
some:{user_id: 999999}      -> null
some:{user_id: undefined}   -> {"id":1}     <-- MATCHES
some:{}                     -> {"id":1}     <-- MATCHES

Workspace.getWithUser({id: member})   -> WORKSPACE 2
Workspace.getWithUser({id: stranger}) -> null
Workspace.getWithUser(null)           -> WORKSPACE 2   <-- FAIL OPEN
Workspace.getWithUser(undefined)      -> WORKSPACE 2   <-- FAIL OPEN
```

Prisma **strips** `undefined` from the filter rather than matching nothing, leaving
`some: {}` — "has at least one member" — which matches every workspace that has any member.
So removing the guard does not produce a harmless no-match. It produces a lookup that returns
**someone else's workspace** to a caller with no user id, and the endpoint then reports that
caller's capabilities against it.

That the mutation went red once is therefore the *correct* result and it is load-bearing, not
incidental: the one red test is the service-actor case, and it is red because the code fails
open, not because Prisma refused the query. The conclusion drawn from the number — that the
guard is not the contract — is the opposite of what the database does.

**So: yes, one unit test on the existing export, and it should pin the mechanism rather than
the outcome.** Something like:

```js
test("a caller with no user id never reaches the lookup", async () => {
  const lookup = jest.fn();                       // must not be called at all
  await expect(workspaceCapabilities({
    actor: { type: "service", id: "api-key:1", orgId: 1 },
    engine: { authorizeMany: lookup },
    user: undefined,
    workspaceId: memberWorkspace.id,
  })).resolves.toBeNull();
  expect(lookup).not.toHaveBeenCalled();
});
```
asserting `null` **and** that nothing downstream ran. An assertion on the return value alone
would pass against a version that queried, found a stranger's workspace, and then happened to
return null for another reason.

And the ledger line should be corrected. A recorded reason that is wrong is worse than no
reason: the next person to touch `getWithUser` will read "Prisma does not match on undefined"
and remove a guard somewhere else on that basis. The true sentence is: *Prisma drops
`undefined` keys, so a missing user id widens the filter to "any member" — the guard is the
only thing between a userless actor and someone else's workspace.*

## Answer 3 — `getWithUser` is a genuine authorized-scope lookup, with one boundary worth stating

Yes, for the case the endpoint uses it in. Confirmed by execution: a member gets the
workspace, a stranger gets `null`, and absent and foreign ids fall out of the *same* query as
"no row" — existence cannot precede membership by construction, which is what the ruling
asked for and what the byte-identical test then pins.

The boundary: it is authorized scope **for a user principal only**. Its filter is a
membership row, not a grant, so a user holding an org-wide `workspace.read` grant who is not a
member of workspace W gets `workspace: null` for W. That is the intended read here — the
endpoint gates affordances and a non-member has no workspace affordances to show — but it
means the answer is *membership-scoped*, not *grant-scoped*, and those diverge for exactly
the org-wide-grant actor. Worth one sentence in the residual so a later reader does not
"fix" the divergence.

## The three contract items

**1. org half survives the workspace half** — held, and by the mechanism that exists rather
than the one the contract described. My pre-read F1 said the prescribed mutation (merge the
two `try`s) could not go red because nothing throws; Dev2 solved it the way I asked, by
injecting a throwing engine through the export. The HTTP test at `:232` additionally asserts
`toHaveProperty("workspace")` and `not.toBeNull()`, so a response that skipped the workspace
half cannot satisfy it — that is the check that stops the org assertion passing vacuously.

**2. lookup through authorized scope** — held. `workspaceCapabilities:41` calls
`getWithUser(user, {id})` and returns `null` on no row; `{}`-instead-of-`null` and an
unfiltered lookup are both covered.

**3. existence does not leak** — held, and correctly. `:257` asserts both bodies **carry**
the `workspace` key before comparing raw text, which closes the hole I flagged: two org-only
bodies are byte-identical too and would have passed a naive comparison. Raw `.text()` is the
load-bearing assertion; `content-length` is checked alongside it and, as I measured, is equal
for key-order differences (44 = 44) — it proves nothing alone, and the test does not rely on
it alone.

## My pre-read findings

- **F1** — closed, as above.
- **F2** — closed. Guard is at `:38` on `!user?.id`, **before** the lookup, and the comment
  gives the reason. See Answer 2 for why it is more load-bearing than the mutation count
  suggested. The `service` test at `:280` asks about a workspace that **exists and has
  members** (`memberWorkspace`), which is the fixture I asked for — an absent id would have
  passed against the broken version.
- **F3** — closed; the non-numeric case is at `:29` with `Number.isInteger(id) || id <= 0`,
  and the test drives `"abc"`, `""`, `"-1"`, `"1.5"` and a SQL-shaped string. The timing
  asymmetry (0 queries vs 1) still stands and should be the residual non-goal I described.
- **F4** — **not covered.** No view-as-user test in this file. `resolveActor` builds the
  impersonated actor with the target's id so the behaviour is right by construction, but
  nothing pins it, and the write-shaped capabilities being false under
  `impersonated_mutation_denied` (6 of the 7 workspace capabilities) is surprising enough to
  be "fixed" later. Not a blocker for this SHA — it is task 2's scope only if PMO says so —
  but it should be an explicit deferral rather than an omission.
- **F5** — deferred to #103, which is the right call; the guard is on `actor.type`… actually
  on `user?.id`, which is equivalent here because `response.locals.user` is only set by
  `validatedRequest` for a real session. Worth noting the guard keys on the *user object*,
  not on `actor.type`, so if a future ingress ever sets `locals.user` alongside an api-key
  context, the workspace half would answer for the creator. #103 is where that lands.

## NIT-1 — the anonymous case proves less than it appears to

`:298` asserts an anonymous caller gets `capabilities: {}` and **no** `workspace` key. True,
but it is true because `!actor` returns at `system.js:1550` before the query string is ever
read — the response shape for an anonymous caller is identical whether or not task 2 exists.
The test is correct and worth keeping as a regression pin; it just should not be counted as
coverage of the workspace half. One comment line.
