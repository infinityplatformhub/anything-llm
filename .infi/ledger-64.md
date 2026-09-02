# Ledger — issue 64, `/v1` chat listings declare the wrong action

`GET /v1/workspace/:slug/chats` calls `WorkspaceChats.forWorkspace(workspaceId, …)` and the thread twin calls `WorkspaceChats.where({workspaceId, thread_id, …})`. Neither filters by `user_id`. The session route does — `forWorkspaceByUser(workspace.id, user.id)` — so an API key whose creator held `chat.read` read every user's chats in the workspace, which is what `chat.read_others` names. Found by QA-1 on #63; pre-existing, and #63 did not widen it.

Ruling: **the routes declare `chat.read_others`, and nothing else changes** (PMO ruling (ข)). The alternative I raised — filter to the creator, matching the session route's self-only shape — cannot work here: an API key is a bearer credential for its creator, not an identity, so "self" is the person who minted the key, who is typically not the person chatting. That filter returns an empty list for the ordinary case, which reads as "this workspace has no chats" rather than "you were refused". A 403 is a wrong answer the caller can see. If wrong, an integration that legitimately reads all chats now needs its creator granted `chat.read_others`, which is the conversation this forces.

Ruling: **`POST /v1/admin/workspace-chats` is included.** It was not in QA-1's report, but it is the same claim: an all-users chat read is `chat.read_others` by definition, whatever the route is called. Leaving it on `chat.read` would keep one door open on the exact property the other two are being closed for.

Ruling: **changed in `ROUTE_SCOPES`, not checked inside the handlers.** The ingress check already evaluates `grants(creator) ∩ scopes(key)`; naming the wider action there is one refusal in one place. A handler-level check would be a second authorization path evaluating the same question, which is how the two halves drift apart. R3 is not violated — `chat.read_others` is a seeded action already used by the engine's `READ_ACTIONS` set and by `ORG_CAPABILITIES`; no new name was invented.

Ruling: **no swagger regeneration.** PMO asked for it, but `swagger/openapi.json` contains no scope names at all (`grep -c "chat.read"` → 0) — the generator documents request/response shapes, and those did not change. Regenerating would produce a large no-op diff.

Two things the RED run showed that are worth stating, because both look like failures and are not:

- With the scopes reverted, `content_moderator`'s key stopped reaching the listings. That is correct and is the strongest evidence the change is right: `content_moderator` is seeded with `chat.read_others` and **not** `chat.read`, so under the old declaration a role explicitly granted "read other people's chats" could not read them, while `editor` — which holds `chat.read` and not `chat.read_others` — could. The declaration was backwards.
- `POST /v1/admin/workspace-chats` stayed 403 for the editor key in RED too. Not a test that fails to discriminate: `editor` is a **workspace**-scoped role and that route asks an org-level question, so it is refused for a second, independent reason. The three-role sweep is what makes the case, not that one route.

Breaking change, recorded deliberately: an existing integration whose key creator holds `chat.read` but not `chat.read_others` now receives 403 on these three routes where it previously received 200. This is the loud failure chosen over the quiet one — the alternative returns an empty list with no indication that anything was withheld.

Verification: 10/10 on the new suite; RED with the three scopes reverted fails 6 of 10. `routeScopes` + `pr4bScopeHttp` 50/50 after the EXPECTED map was updated.

## Test reconciliation after the scope change

Ruling: **the two #63 twins change meaning rather than being deleted.** They asserted a member-creator key gets 200; under #64 that key gets 403, because a member holds `chat.read` and not `chat.read_others`. #63's question was whether the grant half is consulted on these routes at all, and it still is — only the grant they require moved. Rewritten to assert 403 with a comment naming #64.

Ruling: **a positive control was added to that suite in the same commit.** With both twins asserting 403, every case in the file became a refusal — and a route that refused everyone would have passed it. A third key was added whose creator holds `content_moderator` (which carries `chat.read_others`), and every key in the suite now carries the identical scope list, so the 200 against the two 403s is the grant half being consulted. Without this the reconciliation would have quietly destroyed what #63 was testing.

Ruling: **the S-20 fixture gains `chat.read_others` in its key scope list.** It was PMO's first branch and it is the right one: the fixture's keys carried `chat.read`, so after the change the scope half refused before the grant half was reached, and the pair — same scopes, different creators — proved nothing because both keys were refused for the same reason. Not a bug in the route.

Ruling: **NIT-2 is asserted per-route, not as `KNOWN_SCOPES` lacking `chat.read`.** PMO asked for the latter. It passes today (`KNOWN_SCOPES` is derived from `ROUTE_SCOPES`, and no route declares `chat.read` any more) but it says the wrong thing: a genuinely self-only `/v1` chat route would legitimately want `chat.read`, and the blanket assertion would fail on the day someone adds one, pointing at the wrong problem. The test names the three all-users routes and asserts each declares `chat.read_others`.

Ruling: **a retired scope names its replacement.** `chat.read` no longer appears in `ROUTE_SCOPES`, so `validateScopes` answered `Unknown scope(s): chat.read` — true, and useless: it reads as a typo, so the caller's next move is to check their spelling rather than to grant `chat.read_others`. `RETIRED_SCOPES` maps the old name to a sentence saying when it was retired and what took its place. Checked before the unknown-scope filter, so the more specific answer wins.
