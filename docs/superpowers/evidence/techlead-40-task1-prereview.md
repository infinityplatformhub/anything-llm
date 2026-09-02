# Techlead — #40 task 1 pre-review (working tree `.claude/worktrees/f40`)

Reviewed: `021d9e8b` plus the uncommitted modification to
`server/__tests__/security/authorization/workspaceCapabilities.test.js` (the AST rewrite + SHA pin).
Pre-review, no SHA cut. **No blocker.** Three findings to reach Dev2 before task 2, one of which is a
real gap in what a test currently proves.

Diff vs main: 3 files, +353/-10 — `system.js` (+24/-10), `workspaceCapabilities.test.js` (new, 174,
then +77/-46 uncommitted), plan doc.

## The three points asked

### 1. Is `requirePermission`'s metadata enough for a router-stack test to name the resolver? — **No, for 4 of 10 resolvers.**

`requirePermission.js:81-82` sets `middleware.action` and `middleware.resolveResource`. Executed on the
real modules under node 22:

```
direct  workspaceBySlug         -> identity match: workspaceBySlug   fn.name: "workspaceBySlug"
factory workspaceByIdParam("x") -> identity match: NONE              fn.name: ""
```

`resolveResource` is the *closure the factory returned*, not the exported factory, so neither reference
identity nor `.name` recovers which resolver produced it. Four exports are factories —
`workspaceByIdParam`, `chatByIdParam`, `promptHistoryByIdParam`, `memoryByIdParam` — and two calls of the
same factory are not `===` each other either. The six direct resolvers (`orgResource`,
`workspaceBySlug`, `workspaceByBodySlug`, `documentInWorkspaceBySlug`,
`watchedDocumentInWorkspaceBySlug`, `grantScopeFromBody`) resolve cleanly by identity.

**This is not hypothetical for §7.9e.** `workspace.members.manage` is gated **only** through
`workspaceByIdParam("workspaceId")` (`admin.js:342` and `:382`, both multi-line). A router-stack test
asserting "this capability is backed by a workspace-scoped resolver" cannot classify that gate at all
from the mounted stack — it would have to either fail, or skip, and skipping is how a capability with
no gate slips through.

Cheapest fix, and it matches what `requirePermission` already does for itself: have each factory stamp
the closure it returns.

```js
const workspaceByIdParam = (param) => {
  const resolve = async (request) => { /* … */ };
  resolve.resolverName = "workspaceByIdParam";
  return resolve;
};
```

Then a router-stack test reads `mw.resolveResource.resolverName ?? <identity lookup>` and every gate is
classifiable. One line per factory, four factories. Worth doing **before** task 2 writes the
router-stack test around the current shape.

### 2. Mockup SHA pin — **correct, and verified against git.**

The test recomputes git's blob hash (`sha1("blob <len>\0" + bytes)`) over the mockup and compares it
with `MOCKUP_SHA` read from `.infi/task-40.env`. I checked the arithmetic against the object store:
`git rev-parse 021d9e8b:docs/superpowers/mockups/frontend-authz-capabilities.html` →
`2a30aa217f4dee61f3bde67056ea0a720ca5f379`, which is exactly the pinned value. So the pin is live, not
decorative.

Two properties worth naming because they are the ones that make it work: it hashes **bytes**, not the
parsed `WS_CAPS`, so an edit anywhere in the mockup (a persona's permissions, a role table) trips it —
not only an edit to the array the test parses. And it reads the expected value from `task-40.env`
rather than a literal in the test, so the evidence contract and the test cannot disagree about which
mockup was approved.

The `WS_CAPS` comparison sorts both arrays and compares the whole thing, which detects omissions,
additions and duplicates while ignoring order — order has no meaning to `authorizeMany`. Verified the
mockup's `WS_CAPS` (line 150) is byte-identical to `WORKSPACE_CAPABILITIES`.

### 3. Anti-vacuous guards — **present and real, with one gap.**

Good:
- `permissionGates` is now a real AST walk (`hermes-eslint`) rather than a hand-rolled scanner, and it
  carries **its own unit test** feeding it a comment, a block comment, a string literal, a regex
  literal, a template literal and `notrequirePermission(` — asserting exactly two gates come back. A
  scanner without this test is the classic "green because it found nothing".
- `endpointFiles.length > 0` guards the file walk; both capability lists are asserted non-empty; every
  capability is asserted to be in `ALL_ACTIONS` so a typo cannot pass as a capability nobody gates.
- `workspaceResolvers` is *derived* from `module.exports` of `resourceResolvers.js` rather than
  hard-coded, so a new resolver is covered on the day it is added. I ran the regex: it yields the
  8 expected names, excluding `orgResource` and `grantScopeFromBody`.
- The `workspace.create` assertion names both `workspaces.js` and `admin.js` explicitly rather than
  "some file", which is the version that fails if one of the two mount points loses its gate.

**The gap — FINDING-1 (medium, for Dev2 now).** `every workspace capability backs a workspace-scoped
server gate` asks only whether *some* gate anywhere pairs the action with a workspace resolver. Five of
the seven workspace capabilities are **also** gated at `orgResource` somewhere:

| capability | resolvers seen at gates |
|---|---|
| `workspace.read` | workspaceBySlug |
| `workspace.write` | workspaceBySlug, promptHistoryByIdParam |
| `workspace.delete` | workspaceBySlug, workspaceByIdParam |
| `workspace.members.manage` | workspaceByIdParam **only** |
| `document.create` | workspaceBySlug, **orgResource** (`extensions/index.js:19,43`) |
| `document.delete` | workspaceBySlug, documentInWorkspaceBySlug, **orgResource** (`system.js:525,540`) |
| `chat.send` | workspaceBySlug, chatByIdParam |

An org-scope grant carries `workspace_id NULL` and the engine reads it as matching **every** workspace
(migration 044000, and the reason #53 exists). So `document.create` and `document.delete` answered at
`orgResource` are a genuinely different question from the same action answered at `workspaceBySlug` —
and the capabilities endpoint will answer the workspace question while two live routes ask the org one.
The current test passes either way and says nothing about it.

I am **not** claiming those two gates are wrong — `extensions/` and the system document routes may
legitimately be org-level operations. What I am saying is that the test as written would also pass if
*every* gate for a workspace capability were `orgResource`, which is precisely the vacuity this
assertion exists to prevent. Two options, either is fine: assert the count of distinct resolvers, or
add an explicit allowlist of the known org-scope gates for a workspace capability with a comment saying
why each is legitimate. The second is more work and more useful, because it makes the next one visible.

## Two smaller notes

**NIT-1 — `ORG_CAPABILITIES` is not pinned to the mockup, only `WORKSPACE_CAPABILITIES` is.** The
mockup carries `ORG_CAPS` at line 151, byte-identical to the server list, but no test compares them
(`grep -c ORG_CAPS` in the suite → 0). The mockup SHA pin means `ORG_CAPS` cannot change silently — but
`ORG_CAPABILITIES` in `system.js` can, and would drift from an approved design with nothing failing.
`workspace.create` was just added to it in this very commit, which is the shape of edit that would
drift. Same three lines as the WS_CAPS comparison.

**NIT-2 — `hermes-eslint` is a devDependency.** Correct classification (test-only), just worth
confirming the CI job installs dev dependencies before this suite runs; a missing parser here fails at
`require`, which is loud, so this is a note rather than a risk.

## Also checked

- `ORG_CAPABILITIES` gaining `workspace.create` is right and the comment gives the reason: creating a
  workspace has no existing workspace to authorize against, and both `workspaces.js` and `admin.js`
  gate it at `orgResource`. Confirmed at the gates.
- The rewritten `ORG_CAPABILITIES` comment loses the sentence explaining that `authorizeMany` re-throws
  a contract error for the *whole batch*. That reasoning is still asserted by
  `orgMemberAction.test.js:291` (`ORG_CAPABILITIES holds no org-scoped action`), so it is not lost —
  but the new comment ("a contract error, not a false result") is weaker about the blast radius. Not a
  finding; mentioning it since the edit was deliberate.
- `WORKSPACE_CAPABILITIES` contains no org-scoped action and `ORG_CAPABILITIES` no workspace-scoped one,
  both asserted against `ACTION_SCOPES`. Today `ACTION_SCOPES` holds only `org.member`, so these two
  tests are near-vacuous *right now* — but they are the correct assertions to have standing when the
  next scoped action lands, and the comment in `system.js` says plainly that `ACTION_SCOPES` is a
  validator, not a catalog, so the lists cannot be generated from it. Right call.

## What I did not do
Did not run the suite (no `DATABASE_URL`; this suite is static-analysis only and may not need one).
Everything above marked "executed" was run against the real modules under node 22.
