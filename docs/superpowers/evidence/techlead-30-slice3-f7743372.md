# Techlead-1 — #30 slice 3 `f7743372` — S-25 lane — **PASS**, 3 NITs

Reviewed the S-25 (cardinality) lane only: `utils/authorization/cardinality.js`, the
three routes, and the two new suites. Diff for the whole slice is 19 files / +1855
−75; S-25's share is `cardinality.js` (174), the three route changes, and
`cardinalityHttp.test.js` (310) + `cardinalityScope.test.js` (277).

Per §7.14 no suites — in-process probes against the worktree's own module. Results
inline; reproduction at the end.

---

## The three routes

**`vector-search`** — the fix is a *deletion*, which is the right shape. The
`namespaceCount === 0` early return is gone rather than made to match, and the
comment says why: an empty namespace already flows through the search path to the
same empty body, so the branch bought nothing but the leak. One builder
(`buildVectorSearchResponse`) now serves every outcome, so "byte-identical" is a
property of construction rather than of two code paths being kept in step.

The suite compares `status`, raw `.text` **and** `content-type` — not parsed
objects. That is the assertion that would have caught the original bug, since the
bug *was* a stray key.

**`/v1/system/vector-count`** — `scopedTotalVectors` over the ACL filter's
`workspaceIds`, org-wide still gets `totalVectors()`. The comment that
`workspaceIds` is already `ceiling(creator) ∩ binding(key)` is correct and I
verified the consequence it claims: a key bound to a workspace its creator holds no
grant for intersects to nothing and totals 0, with no second check. Adding one here
would be a second definition of the same rule — right call.

**`/system/system-vectors`** — scope checked before the store. Out-of-scope answers
404, identical to absent.

## Rule 1 (scope before store) — measured, and it holds including the path I expected to leak

```
in-scope       -> 7     store hits 1
out-of-scope   -> null  store hits 0
absent         -> null  store hits 0
matchNone      -> null  store hits 0    <- resolveSlug not called either
```

The last line matters more than the first three: `matchNone` returns before even the
*slug lookup*, so a match-none caller and an out-of-scope caller do not differ by a
database round trip either. The file's stated reason for rule 1 is timing
indistinguishability, and this is the case where a partial implementation would have
satisfied the body-equality tests while leaving a measurable difference.

The cap test asserts `namespaceCount.mock.calls.length` is unchanged after a refusal
— i.e. it refused *before* fanning out. A cap that queries 51 namespaces and then
throws has prevented nothing; asserting the absence of the calls is the only way to
tell those two implementations apart.

## The cap, and the `partial: true` that was withdrawn

Throwing rather than truncating is correct, and the comment gives the better of the
two available reasons: a shape that varies with the caller is itself a signal about
the caller. The weaker reason (a truncated number looks like a right one) is also
true and also stated. `WORKSPACE_COUNT_CAP = 50` is tied to #81 with the condition
for removing it written down.

## The fixture correction is the most valuable thing in this lane

Dev4's finding — the suite's main key was created by an admin holding an org-wide
grant, so **no workspace was foreign to it** — is the exact failure mode I have been
flagging all sprint: a test green for the wrong mechanism. The 403/200 split it
produced was the fixture being wrong, not the route. The replacement creates a
scoped member key so there is a genuinely foreign workspace to point at, **and** adds
a positive control (`card-mine` → 200) so the matching refusals are proven to be a
scope decision rather than a key that cannot reach anything at all.

`"the empty body is the ordinary result shape"` is the same discipline applied to the
byte-equality test: a route that 500'd on both inputs would satisfy equality and be
entirely broken.

## `resolveActor(request)` — the signature bug, and the sweep you asked for

**No other call site has this shape.** All seven production sites in the tree pass
both arguments:

```
endpoints/api/openai/index.js:142      resolveActor(request, response)
endpoints/api/system/index.js:119      resolveActor(request, response)
endpoints/api/workspace/index.js:728   resolveActor(request, response)
endpoints/api/workspace/index.js:892   resolveActor(request, response)
endpoints/api/workspace/index.js:1033  resolveActor(request, response)
endpoints/system.js:1407               resolveActor(request, response)
utils/middleware/requirePermission.js:42, utils/middleware/validApiKey.js:33
```

(`CoreJobWorker.js:14` is `identityStore.resolveActor(job.actor)` — a different
function.) So the lane is clean.

**Why static analysis cannot see it**, and what to do about it: the guard is
`const locals = response?.locals ?? {}`. Optional chaining means a missing
`response` is not an error — it is an empty locals object, which falls through every
ingress branch to the final `return null`. And a null actor is **not** a safe
default in the way it first appears: I confirmed `buildDocumentFilter({actor: null})`
returns `{matchNone: true, orgWide: false, workspaceIds: []}`, so on the retrieval
path the bug fails *closed* (reads nothing). But on a **single-user** deployment the
same missing argument falls to `isConfirmedSingleUser()` and returns
`SINGLE_USER_ACTOR` — a service principal, evaluated by the engine like any other.
So the same typo is silently-restrictive in multi-user and silently-broad in
single-user, and neither is a crash.

### NIT-1 — make the second argument non-optional in fact, not only in the JSDoc

`resolveActor.length === 2`, and the JSDoc documents `response` as required, but
`response?.` makes omitting it legal at runtime. One line makes the class of bug
loud instead of silent:

```js
if (arguments.length < 2)
  throw new Error("resolveActor(request, response) requires the response — locals carry every ingress's identity");
```

The optional chaining can stay for `response.locals` being absent (a plain object in
a test), which is the case it was written for. What should not stay is *omitting the
parameter entirely* being indistinguishable from an unauthenticated request. This is
the #40 lesson in a different costume: a guard that cannot tell "nothing was passed"
from "nothing was found".

### NIT-2 — the routes read the actor two different ways

`system.js` uses `response.locals.actor` (populated by `requirePermission`);
`api/system/index.js` and the three workspace sites call `resolveActor(request,
response)` directly. Both are correct — `/v1` routes go through `validApiKey`, which
also sets `locals.actor` — but two idioms for one thing is how one of them ends up
missing. Preferring `response.locals.actor` everywhere it is set would make NIT-1's
failure mode unreachable on those routes entirely, since there is no second argument
to forget.

## NIT-3 — `buildVectorSearchResponse` is in `utils/authorization/`

It is a response serializer with no authorization logic in it. It lives there because
its *reason* is an ACL leak, which is good provenance and a bad address: the next
person adding a field to the vector-search response will not look under
`authorization/` for it, and a second serializer appearing next to the route is how
the two bodies drift apart again. Consider `utils/vectorSearch/response.js` with the
comment kept verbatim. Not blocking — the tests pin the behaviour either way.

---

## Verdict

**PASS** on the S-25 lane. The three NITs are all "make the next mistake louder"
rather than defects in this SHA.

I did not review S-22 (rehydration), `pinnedContext`, `curateSources`, or the
`docVectorsCanonicalize` comment — those are outside the lane assigned.

## Reproduction

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd .claude/worktrees/t5slice2/server
node -e '<scopedNamespaceCount over in-scope/out-of-scope/absent/matchNone, counting store hits>'
node -e '<scopedTotalVectors: null filter throws, orgWide=999, scoped sums>'
node -e '<buildDocumentFilter({actor:null}) -> matchNone:true>'
grep -rn "resolveActor(" server/endpoints server/utils server/jobs   # 7 sites, all two-arg
```

Read-only: nothing in the worktree was modified.
