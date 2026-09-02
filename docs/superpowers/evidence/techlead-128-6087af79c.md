# Techlead-1 — #128 `6087af79c` (auth): **PASS**

§7.14: no suite run. Probes are in-process `node -e` against the slice's own files in a
detached worktree (`git worktree add --detach /tmp/tl-128 6087af79c`, Node 22), driving
`canAssignLegacyRole` through a stub db that captures the Prisma `where`.

## The two things I asked to check

**1. The scope clause is a sibling of the pairs inside `AND`, not folded into the `OR`.**
Captured `where` for a user actor in a group:

```json
{"AND":[
  {"orgId":1,"OR":[{"expires_at":null},{"expires_at":{"gt":"<date>"}}]},
  {"OR":[{"principal_type":"user","principal_id":"5"},
         {"principal_type":"group","principal_id":"9"}]},
  {"workspace_id":null}
]}
```

Three AND terms: org+expiry, principal pairs, scope. The failure I was watching for —
`{OR:[...pairs, scope]}`, which would read as "principal matches **or** scope matches" and let
a workspace-A group grant satisfy a workspace-B target — is not present. `heldPermissionIds`
`:246-286` builds `scope` first (`:247-250`) and passes it as its own AND element (`:275`).

**2. The null-`grantPrincipal` guard runs before `grantPrincipalPairs`.** `:253-256`:
`grantPrincipal` is resolved, `if (!grantPrincipal) return new Set()`, and only then are pairs
built. Measured with `grantPrincipal: null`: the grants query never ran and `group_members` was
never touched — the function returns an empty set rather than throwing on `principal.type` into
a caller's catch. That was the #112 fail-open shape and it is closed by ordering.

## The rest, measured

- **Group expansion happens, and only for user actors.** A user with no direct grant now has `group_members` queried and a `{principal_type:"group"}` pair added. An api-key actor (`grantPrincipal` set) produced pairs `[{user,5}]` only, with `group_members` never queried — the same refusal `engine.js:189-196` makes, for the same reason, so the two layers cannot answer differently about who a key is.
- **The org threads through both queries.** With `actor.orgId = 7`, the group lookup was `{"user_id":5,"groups":{"orgId":7}}` and the grants query filtered `orgId: 7`. Not hardcoded 1 on either side.
- **`grantPrincipalPairs` reused, no new group query.** The expansion rule stays in `groupMembership.js` — which was the structural point of the pre-read, since a second query here would recreate the split the issue exists to close.

## Fixtures

The two vacuous ones Dev3 caught are worth recording as found rather than as fixed. I verified
both diagnoses independently:

- `member`/org keeps **exactly `chat.send`** after `20260902044000:44-54` deletes nine of the ten actions seeded at `20260902020000:312-317`, and `chat.send` is in `BASELINE_GRANTABLE`. So the original fixture could not fail for any actor — not merely weak, unable to measure. `content_moderator` (`:306-310`) holds seven actions, none in the baseline.
- `viewer`/workspace (`:334-337`) is a strict subset of `owner`/workspace (`:319-325`), so containment passes and the scope clause is the only thing that can refuse — which is what RF-2 has to isolate.

RF-4 (`:324-345`) asserts the engine and the repository agree on one fixture, which is the
invariant this issue is about, asserted directly rather than as two separate outputs. RF-3 has
both directions (`:257`, `:289`): a key whose creator holds the role through a group is refused,
one whose creator holds it directly still works — the second is what stops the fix from
breaking every api-key.

NIT-1's tests (`:347-387`) pin that the exemption is by **name** rather than by
not-being-a-user, which is the #123 lesson applied here.

## Residuals, both correctly recorded

- **+1 query per call** — the price of one expansion rule in one place. Cheaper than two answers that disagree.
- **The UI will now show controls to a delegated admin.** This is the *goal* of #123, not a side effect: `assignableRoles` starts answering correctly for an actor whose role arrives through a group. The ledger cites #123 back, so it does not read as an unrequested behaviour change.

The `refuseGroupEscalation` docblock's KNOWN LIMIT is replaced with a statement of why the two
issues had to land in this order (`policyRepository.js:123-128`) — the chain is written down in
the file that would otherwise show only one half of it.

## Verdict

**PASS.** Both structural risks I named are absent by construction rather than by test, the
expansion is the engine's own helper, and the two fixtures that could not fail were found by
the dev before review.
