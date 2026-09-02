# Techlead review — #63 `dabe635e` (grant `chat.read` to workspace roles)

**Verdict: PASS.** The ruling is correct as an authorization policy, the migration matches it
exactly, and the test that overturned my own advance analysis is in the suite as a permanent
guard. Two nits, no findings.

I gave PMO an advance analysis before this SHA existed, and **one of my recommendations was
wrong**. See §Correction — the mechanism I missed is the reason ruling (ก′) exists.

## Correction — org `member` must NOT hold `chat.read`, and I said it should

My advance note argued that every role holding `chat.send` should hold `chat.read`, "ส่ง
ข้อความเข้า workspace ได้แต่อ่านที่ตัวเองส่งไม่ได้ ไม่ใช่ policy ที่ตั้งใจ". That reasoning is
sound for the three **workspace** roles and wrong for org `member`, and the difference is a
mechanism I already knew and failed to apply:

An org-scope grant carries `workspace_id NULL`, and `engine.js` reads a NULL-workspace grant
as matching **every** workspace while never consulting `workspace_users`. So `chat.read` on
org `member` is not "read your own history in workspaces you belong to" — it is "read chat
history in every workspace on the instance, including ones you have never joined."

This is the same shape T-4a removed from this exact role for `workspace.read`/`workspace.write`,
documented in `seeds/permissions.js:138-149`, and the same shape I verified myself during the
`workspaceBySlug` blast-radius round. I applied the `chat.send` symmetry and did not check
what the grant's scope would mean.

Dev5's first cut did include org `member` and `chatReadGrant.test.js` caught it: an outsider
got **200 with someone else's chat history**. The finding is theirs, from running the test
rather than reasoning about the grant — which is the correct order and the reason the test
exists. Ruling (ก′) is right and my advance note should be read as superseded.

The two things I did get right stand: `content_moderator` is affected (there is no
`read_others → read` implication in the engine), and self-only behaviour needed pinning
rather than assuming.

---

## The policy — correct against §PMO

`plans/t4a-action-map.md` maps chats and threads to `chat.read` for read, and rule 2 keeps
"other users' data" on `chat.read_others`. The four gated routes match: `workspaces.js:428`,
`:670`, `workspaceThreads.js:71`, `:149`, plus the two `/v1` twins via
`scopes.js:29,40`.

**Nothing that should hold it is missed, given the scoping constraint.** Every real user
reaches `chat.read` through their workspace membership grant, which
`syncWorkspaceMembershipGrant` derives from `workspace_users.role_id` — so owner/editor/viewer
covers the population. `content_moderator` and `setup_admin` reach their own history the same
way; they are org roles and must, for the reason above.

**Nothing gains anything it should not.** `chat.read_others` is untouched, asserted by an
exact-set query. Viewer's inclusion is right and the comment gives the right reason: a viewer
already holds `chat.send`, so excluding it leaves a role that can write a chat and not read
the one it just wrote.

## Migration 101000

- **Slot** `20260902101000` — after `100000` (#61) and `090000` (#50), no collision. Verified
  that a trial merge of this branch onto main (`ba486811`, which carries #50) auto-merges
  clean: only `seeds/permissions.js` needed merging and it resolved without conflict.
- `ON CONFLICT DO NOTHING`, so re-running is a no-op.
- **`policy_versions` bump present**, and the comment explains what it buys rather than
  asserting it: `FilterCache.get` reads `currentPolicyVersion` on every call, so this row is
  what makes the grant take effect without a restart. Easy to omit; a grant change with no
  bump serves pre-grant decisions until the TTL expires.
- **Seed file synced** — `chat.read` added to owner/editor/viewer in `permissions.js`, so a
  fresh database and an upgraded one agree.

The comment block is the best part of the commit. It records **why nothing caught this**:
`routeWiring.test.js` exercises these routes with a `manager` fixture, and managers carry an
org grant, so the gate passed there for a reason that does not generalise to the users who
actually use the product. That is the class — a fixture privileged differently from the
population — and naming it is worth more than the fix.

## The 11 tests

The three I asked for are present and each is stronger than what I asked:

- **`content_moderator` outsider 404** — with a **premise guard**: it first asserts
  `chat.read_others` is allowed, so the 404 is the absence of `chat.read` and not a grant
  that failed to land. Without that guard the test would pass on a broken fixture.
- **self-only across the routes** — creates a real neighbour (workspace member, editor grant,
  own chats in both the workspace and their own thread) and asserts the rendered response
  does not contain the neighbour's marker, **plus** `history.length > 0` on both, because an
  empty response would also "not contain" it. This is the assertion my advance note asked
  for, and the premise guard is the half that makes it mean something.
- **thread 404 with its two causes separated** — a 404 on the thread route has two possible
  causes (the `chat.read` gate, and `validWorkspaceAndThreadSlug` filtering by `user_id`).
  The suite pins each independently: MEMBER owns the thread in one test so only the gate can
  404, and a foreign thread in the next with an explicit gate-allowed assertion so only the
  ownership filter can. Neither can mask the other, and the comments say so.

`toEqual` rather than `arrayContaining` on both exact-set queries, with the reason stated:
containment would stay green if org `member` came back. That is the assertion which locks the
ruling in, and it is the difference between a test that documents the fix and one that
prevents its regression.

The RED is named: before the migration, `decide(MEMBER, "chat.read", workspaceResource())`
returns `{allowed: false, reason: "no_permission_in_roles"}` — the specific reason, not just
a failure.

## NIT-1 (low) — the org-outsider test does not assert *why* it 404s

`an org member who is not in the workspace is still refused its chat history` creates a user
via `User.create` and asserts 404. Every other test in the file carries a premise guard; this
one does not, so it would also pass if `User.create` silently failed to grant the org
`member` role at all — in which case it proves "a user with no grants is refused", which is
true but not the property being defended.

One line, matching the style already used twice in the file:

```js
const grants = await prisma.principal_role_grants.findMany({
  where: { principal_type: "user", principal_id: String(outsider.id) },
});
expect(grants).toHaveLength(1);   // they ARE an org member; that is the point
```

Not a blocker — the exact-set test independently pins that org `member` does not hold
`chat.read`, so the regression cannot land silently.

## NIT-2 (low) — `/v1` twins are not covered

`scopes.js:29,40` map `GET /v1/workspace/:slug/chats` and the thread twin to `chat.read`,
and the migration comment names all four routes. The suite exercises the two session routes
only.

The API-key path is a different gate (`validApiKey` scope check plus
`grants(creator) ∩ scopes(key)`), so a key whose creator lacks `chat.read` is still refused —
the fix reaches `/v1` through the creator's grants rather than through the route. Worth a
sentence in the ledger; the residual is that nothing pins it.
