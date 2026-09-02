# Techlead-1 — #40 task 1, `e875cd1`

Reviewed: `3d29de9..e875cd177` (Dev2, worktree `.claude/worktrees/f40`).
Verdict: **PASS — do not block on the registration counting.** The regex-plus-guard answer is
sufficient for task 1, and the implementer's objection to the export-list alternative is correct.
One NIT.

Delta: WeakSet identity registry, `dynamic` bucket, zero-unclassified assertion, resetModules test,
`buildRouter` accepting the two-argument mount shape, `/v1` guards.

## PMO's question: is regex + specific guard enough, or block until `(apiRouter)` occurrences are counted?

**Enough. Ship it.** Three reasons, measured rather than argued.

**1. The counting alternative is the same kind of thing, not a stronger kind.** A loose call-shape
count over `index.js` is still a text scan of the same file — I ran it: `32`, identical to the current
regex's yield. Swapping a tight regex for a loose one moves the blind spot rather than removing it.

The genuinely stronger option is exporting the mount list from `index.js`. **Correction:** the
implementer's stated objection — that requiring `index.js` boots the server — is wrong on the facts,
and Dev2 measured it: `index.js:212` guards `bootHTTP` behind `require.main === module`, `:215`
exports `{app}`, and a require costs ~1s without listening. I verified both lines. (`bootSSL` at `:96`
is guarded by `ENABLE_HTTPS` rather than by `require.main`, so it is unreachable in a test
environment too.)

The reason to accept the regex anyway is different: exporting the real mount list means rewriting
`index.js:103-134` into a loop — **changing the boot path so a test can inspect it more easily.** That
is a cost task 1 should not pay, and the ~1s per require is a second, smaller reason. The objection
was wrong; the conclusion it was offered for still holds on better grounds.

**2. What actually closes the hole is the `/v1` guard, and it works.** Measured on the mounted router:

```
REG=32  ROUTES=305  V1=62  V1 mutating=37  V1 mutating without validApiKey=0
gates=171  unclassified=0  skipped=["agentWebsocket: app.ws is not a function"]
/v1/openai/chat/completions present=true
```

The `/v1 >= 60` + named-route assertions are *content* assertions, not shape assertions. A future mount
written in a shape the regex misses would drop `/v1` routes and turn those red — which is exactly what
`registrations === 31` could not do, because it pinned the regex's own yield.

**3. The RED is real.** I stripped `[validApiKey(...)]` from `POST /v1/embed/new` and re-ran the sweep:
**37 of 37** mutating `/v1` routes reported as unguarded. That is more than Dev2's claim of one route
going red, and the reason is worth stating — removing the middleware breaks the `scopeFor` import
chain for the whole `embed` module, so the collapse is louder than the mutation. Either way the guard
fires, and it fires on the property that matters (`isApiKeyGuard`, the WeakSet stamp) rather than on a
name. Worktree restored; `git diff` on `endpoints/api/embed/index.js` is empty.

So: the regex remains fragile, and the guards behind it now fail on the consequence rather than on the
shape. That is the right structure, and it is a strictly better position than the one #52 shipped.

## The identity registry — verified, and it closes bypass 5

`Symbol.for(...)` on `globalThis` holding three `WeakSet`s (org / workspace / dynamic). Symbol.for is
the right choice: `jest.resetModules()` gives a second module instance, and a module-local WeakSet
would then classify correctly-wired resolvers as unknown. The registry survives because the symbol is
global while the sets stay weak.

Executed against the real modules:

| candidate | classified |
|---|---|
| real `orgResource` | **org** |
| real workspace resolvers (8) | **workspace** |
| `grantScopeFromBody` | **dynamic** |
| `Object.assign(async () => null, {resolverName: "workspaceBySlug"})` | **null** |

That last row is bypass 5, dead. Identity cannot be forged; a name can. The test's `unknownResolvers`
list now includes both spoof shapes — a function *named* `workspaceByIdParam` and one carrying that
`resolverName` — plus `orgResource` itself as a negative for the workspace question, which is the
right way to prove the buckets are distinct rather than merely non-empty.

**`grantScopeFromBody` as `dynamic` is the correct call** and matches what I flagged: it resolves org
or workspace depending on the body, so classifying it as either would be a lie. `dynamic resolvers
cannot back fixed-scope capabilities` asserts it satisfies neither — the assertion I would have asked
for. The `unclassified === 0` sweep is what makes the three buckets exhaustive rather than optimistic;
measured 0 across all 171 gates.

## FINDING-2 from my last review — closed
`API_KEY_PEPPER` is set at the top of the file like the other 34 suites, and the skip assertion
(`skipped` empty except `agentWebsocket`) is in both this suite and `routeGateSweep.test.js`. I proved
the guard's teeth last round by prepending a `throw` to `admin.js`; that evidence stands and PMO has
it.

## NIT — the `/v1 >= 60` threshold has the same slack the old `> 100` had
62 routes today, threshold 60. A change that removed two `/v1` routes would pass. The named-route
assertion (`/v1/openai/chat/completions`) is what carries the real weight here, and it is
well-chosen — a distinctive path in a module nothing else touches. Worth knowing that the numeric half
is decorative at this margin; not worth a change now, since the mutation I ran shows the failure mode
is a collapse to zero rather than a slow drift.

## Everything else re-verified at this SHA
Mockup SHA pin against the plan doc; both capability lists compared sorted; `DUAL_SCOPE_WORKSPACE_ACTIONS`
asserting `document.create` and `document.delete` in both scopes (measured: create ws:5/org:8, delete
ws:2/org:2); `workspace.members.manage` ws:2/org:0; every ORG capability with an org gate.

## What I did not do
Did not run the suite (§7.14). Every number above comes from mounting the real router under node 22
and reading its stack, plus one mutation applied and reverted in place. No file left modified by me —
the two files `git status` shows dirty in that worktree (`routeGateSweep.test.js`, `validApiKey.js`)
are Dev2's uncommitted work, not mine.
