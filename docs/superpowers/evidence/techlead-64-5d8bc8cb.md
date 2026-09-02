# Techlead — #64 `/v1` chat listings declare `chat.read_others`, `5d8bc8cb`

Reviewed: `5d8bc8cb` (Dev1, worktree `.claude/worktrees/pr64`, branch `approof/64-chats-self-only`)
Base: `173c832f` (= `approof/main`)
Verdict: **PASS**. No blocker, no major. Two NITs.

Diffstat: 6 files, +302/-6 — `scopes.js` (3 values), `routeScopes.test.js` (EXPECTED map),
`chatReadOthersScopeHttp.test.js` (new, 264), residual note, ledger, task env.

## The claim, verified against the handlers

All three routes return every user's chats. Confirmed by reading them, not by report:
- `api/workspace/index.js:463` → `WorkspaceChats.forWorkspace(workspace.id, …)` — no `user_id`.
- `api/workspaceThread/index.js:311` → `WorkspaceChats.where({workspaceId, thread_id, api_session_id: null, include: true})` — no `user_id`.
- `api/admin/index.js:719` → `WorkspaceChats.whereWithData(…)` — an instance-wide export.

The session twins narrow via `forWorkspaceByUser(workspace.id, user.id)`. So the routes were declaring
`chat.read` — the action that names the caller's OWN history — for reads that are definitionally
`chat.read_others`. Correct diagnosis, correct fix.

`grep -c '"chat.read"' scopes.js` → 0. No chat route was missed; `embed.chat.read` (2 routes) is a
different action and correctly untouched.

## Why changing `ROUTE_SCOPES` alone is sufficient

`validApiKey.js:136-147` computes `scopeAllowed = context.scopes.includes(action)` and then
`grantAllows(action, …)` through the engine — `grants(creator) ∩ scopes(key)`, one refusal at one
place, scope half first so a request that already failed cannot make the policy store work. Naming the
wider action at ingress is therefore the whole change; a handler-level check would be a second
authorization path evaluating the same question. Ruling is right and the reason given is the right one.

R3 not violated: `chat.read_others` is already seeded (`permissions.js:23`), already in the engine's
`READ_ACTIONS`, already in `ORG_CAPABILITIES`. No new name invented.

## The two RED observations — both correct, and the first is the strongest evidence here

**`content_moderator` inversion.** Verified against the seed: `content_moderator` (org) holds
`chat.read_others` and NOT `chat.read` (`permissions.js:143`); `editor`/`owner`/`viewer` (workspace) hold
`chat.read` and not `chat.read_others` (`:186,193,204`). Under the old declaration a role explicitly
granted "read other people's chats" was refused these routes, while a workspace editor granted only
"read your own" was allowed. The declaration was exactly backwards, and this is what makes the change a
correctness fix rather than a tightening. Dev1's reading is right.

**`POST /v1/admin/workspace-chats` stays 403 for the editor key in RED.** Also correct, and correctly
flagged rather than hidden: `editor` is workspace-scoped and that route asks an org-level question, so
it is refused for a second, independent reason and does not discriminate on its own. The suite does not
rest on it — the moderator/superAdmin ALLOW arm is the positive control for that route
(`test:225`, "without it, the 403 above is equally consistent with a route that refuses everyone"),
which is the §7.9 shape. The three-role sweep carries the case.

## Test quality

`chatReadOthersScopeHttp.test.js` — real Postgres, `migrate deploy`, real HTTP stack, real key digests.
- All three keys are minted with **identical** `scopes` (`KEY_SCOPES`), and the suite asserts that
  equality directly (`expect(editorScopes.scopes).toBe(moderatorScopes.scopes)`) plus
  `toContain("chat.read_others")` before asserting 403 vs 200. So the refusal is provably from the
  creator's GRANTS, not from the key's list — the property the whole "ROUTE_SCOPES is enough" argument
  rests on, asserted rather than argued.
- The leak assertion is on content, not status: `expect(response.text).not.toContain(OWNER_SECRET_TEXT)`
  across all three refused routes. A 403 with the body still rendered would pass a status-only test.
- `editor` is granted with `workspaceId: workspace.id` (a workspace role granted per workspace), not
  org-wide. That matters: an org-wide grant would be a different question and would have made the ALLOW
  arm meaningless.
- Positive arm asserts the owner's text IS present for the two roles holding `chat.read_others`, so the
  test cannot pass by refusing everyone.

## Swagger — ruling verified, not accepted on report

`swagger/openapi.json` contains no scope names (`grep -c "chat.read"` → 0). The generator documents
request/response shapes, and none changed. Not regenerating is right; regenerating would be a large
no-op diff.

## NIT-1 — `chat.read` is no longer a mintable scope, and the residual note covers only the old keys
`KNOWN_SCOPES` is derived from `Object.values(ROUTE_SCOPES)`, so after this change `chat.read` is gone
from it — verified by executing the module: `KNOWN_SCOPES.includes("chat.read")` → **false** (35 entries).
`ApiKey.create` runs `validateScopes`, which throws `Unknown scope(s): chat.read` on any unknown name.

Consequence beyond the recorded residual: an integration that MINTS keys with an explicit list including
`"chat.read"` (`POST /v1/admin/api-key` style, or the admin UI passing a stored list) now fails at
creation with a 400, not just at request time with a 403. The residual note in
`docs/superpowers/residual-risks.md:110` describes the backfilled-key half ("dead scope … harmless,
confusing in audit") and the `[→ #64]` breaking-change note at `:106` describes the 403 half; neither
mentions that naming `chat.read` at mint time is now a hard error. Existing keys are unaffected —
`validateScopes` runs only on create, and `resolve` does not re-validate — so this is a documentation gap,
not a defect. Worth one clause in the residual note.

## NIT-2 — no test pins `chat.read`'s disappearance from `KNOWN_SCOPES`
`apiKeyScopes.test.js` asserts `KNOWN_SCOPES` excludes `"*"` and that presets are subsets, but nothing
asserts the vocabulary's membership. Since `KNOWN_SCOPES` is derived, a future route re-declaring
`chat.read` would silently restore a mintable scope with no route behind it. One line in the existing
suite would pin it. Not a blocker.

## What I did not verify
Did not run the suite (10/10 new, 6/10 failing in RED with the scopes reverted, 50/50 on
`routeScopes` + `pr4bScopeHttp` — reported by Dev1 via PMO). Review is of the diff and the working tree.
Executed `scopes.js` directly to check the derived vocabulary; that is the only thing I ran.
