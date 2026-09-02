# Techlead-2 verdict — #136 slice 2 `c91a0719c`

**Skills invoked:** `security-review` (auth tier — this function removes every
authorization row a user holds, driven by an actor whose escalation guards are the only
thing between a moderator and a super_admin group). `requesting-code-review` does not
resolve by name in this session (`Unknown skill`, bare and `superpowers:`-namespaced), so
the reviewer template was read from disk. No `infi-lessons` line.

**Verdict: PASS, with one NIT that is a real gap in the suite, not in the code.**

`c91a0719c` is `6a379f735` plus 24 ledger lines; `git diff --stat` confirms no code change,
so my read of `6a379f735` carries.

Worktree `/tmp/tl2-136s2` (`git worktree add --detach`), own scratch database
(`CREATE DATABASE t136s2 TEMPLATE t98b`). **Baseline: 11 passed, 11 total.** Tree clean;
probe script removed.

---

## The claims, each measured

### Primitives, not raw writes — and each primitive's guard is separately pinned

I did not read the loop and agree with it. I replaced each primitive with the raw
statement it stands in for:

| # | mutation | result |
|---|---|---|
| M1 | `removeGroupMember` → `tx.group_members.deleteMany` | **F9 red** |
| M2 | `revokeDocumentAcl` loop → `tx.document_acl.deleteMany` | **F10 red** |

Both kill on exactly one fixture, and both fixtures are the ones Dev5 says were added
after the mutants survived. That is the right causal story and it holds up: F9 and F10 are
the only assertions in the file that can see these two mutations.

F9 in particular is well constructed. Its comment claims F8 alone is insufficient because
a `content_moderator` is refused by `revokeGrant` before the missing membership guard could
matter — so the fixture builds a user with **no grants and no ACL rows**, making
`removeGroupMember` the only primitive called. I confirmed the mechanism by running M1: F8
stays green, F9 goes red. The claim is true as stated.

F9 also asserts the positive half — the legitimate actor still completes the offboard —
so it is a guard rather than a wall. A fixture that only proves "it throws" is satisfied by
throwing always.

### N version rows, and the rollback scope that justifies them

My `05a32c365` ruling required that the transaction be justified by **rollback scope**
rather than by a tidy row count, and that `bumpVersion` stay unexported. Both hold:
`bumpVersion` is still module-local and absent from `module.exports`, and the header states
the reasoning with TL-1's measurement attributed.

F2 is the fixture that earns it, and its mechanism is the correct one: the failure is
injected with `prisma.$use`, not `jest.spyOn`. That distinction matters and the comment
names it — middleware fires for the transaction client; a spy on `prisma.document_acl`
does not, so a spy-based version of this test would inject nothing and pass vacuously.

| # | mutation | result |
|---|---|---|
| M4 | drop the `inTransaction` wrapper | **8 red** (F1, F2, F3, F4, F6, F8, F9, F10) |
| M8 | enumerate ACLs on `prisma` instead of `tx` | **3 red** (F2, F4, F10) |

M8 is the one worth naming: reading outside the transaction is a subtle version of the
same bug, and it is caught. F2's rollback assertions include `grant_revocations` and
`policy_versions` counts — the two things a partial commit leaves behind describing a
removal that did not happen.

### F1 is the RED fixture I asked for

I required a fixture that drives `cache.invalidateScopes` on a **live instance**, not one
asserting "bumpVersion was called". F1 is exactly that: it constructs a `FilterCache`,
builds a filter through it (asserting `cache.size === 1`, so the cache genuinely populated),
offboards, then builds again **through the same instance** and requires the workspace to be
gone. A version written under a scope key no entry carries cannot satisfy it.

M6 (drop `workspace_id` from the `revokeGrant` filter) reds **F1**, F3 and F7 — so F1 has
teeth against a scope-key error, which is the property it exists to hold.

### One call per (role, workspace) pair

| # | mutation | result |
|---|---|---|
| M5 | revoke only the first grant | **F3, F7 red** |
| M6 | pass `workspaceId: null` for every grant | **F1, F3, F7 red** |

So a single call cannot stand in for two grants, and the workspace half of the filter is
load-bearing.

### Idempotency, exactly

F7 takes its baseline **after** the first offboard and asserts exact equality on three
counts. That is the only assertion shape with teeth here, and the fixture says why: every
"the user has no access afterwards" assertion in F1/F3/F4/F6 is green under a blind re-run,
because the user is already offboarded — only a row count separates a no-op from a re-run.

**M7** (add a blind extra `removeGroupMember` call on re-run): **F7 red**, alone.

### `requireActor` fires from this function, before any work

**M3** (delete `requireActor`): **F11 red**, alone. F11's comment records that an earlier
version of itself used a bare id and the mutation survived — with no rows, the enumeration
finds nothing, no primitive runs, and the function returns cleanly. Building the fixture on
a user who **has** rows is what makes the refusal attributable to this function rather than
incidental to the first primitive. That is the §7.9 reasoning applied correctly.

### Actor is a real `super_admin`; `singleUser` only builds worlds

Confirmed by reading the fixture: `ACTOR` is a real user holding `super_admin`, `SETUP` is
`SERVICE_PRINCIPALS.singleUser` and appears only in `world()` and the F9 setup. This is the
control I required, and F8 is the fixture that proves the guards run: a `content_moderator`
is refused, **and** nothing was removed on the way to the refusal.

**M10** (force every primitive to receive `coreJobs`): **F8, F9 red**. So a wholesale guard
bypass is caught.

---

## NIT-1 (non-blocking) — M9 survives, and the gap is real

**M9**: pass an exempt principal (`coreJobs`) to `revokeGrant` **only**, leaving
`removeGroupMember` and `revokeDocumentAcl` on the caller's actor. **11/11 still green.**

I did not report this as "survived". I built the world the suite does not contain — a user
with **grants but no group membership** — and drove a real `content_moderator` at it:

```
unmutated:  REFUSED: revoke refused: actor does not hold role.revoke in this scope
            grants remaining: 1
under M9:   ALLOWED {"memberships":0,"grants":1,"acls":0}
            grants remaining: 0
```

So under M9 a `content_moderator` strips another user's org role. It is a genuine
privilege escalation, and no fixture in the file sees it — because every world the suite
builds gives the user a group membership, so `refuseGroupEscalation` refuses the moderator
first and `revokeGrant` is never reached with the mutated actor.

This is the **same shape as F9, in the other direction.** F9 exists because F8's world
made `revokeGrant` the first refuser and hid the membership guard. The complementary world
— grants, no membership — makes `removeGroupMember` absent and hides the grant guard. Dev5
found one half of the pair and stopped.

**Ask (not blocking the merge):** add F12, the mirror of F9 — a user holding a role grant
and no group membership, offboarded by a `content_moderator`, refused, grants intact. It
is a dozen lines and it closes the last actor-substitution mutant. The code is correct
today; what is missing is the assertion that keeps it correct.

I am not blocking on it because the property is genuinely held by the code at this SHA and
M10 catches the wholesale version. But a suite that cannot see a per-primitive actor
substitution is one refactor away from not noticing one.

## Residual

`document_acl.principal_id` is TEXT with no foreign key, so enumerating a user's ACL rows
is a string match. The header says so and attributes it to #135. Correct to note and
correct not to fix here — an FK on that column is a schema change.

## Mutation summary

10 mutants fired, **9 killed**:

| # | mutation | reds |
|---|---|---|
| M1 | raw `group_members.deleteMany` | F9 |
| M2 | raw `document_acl.deleteMany` | F10 |
| M3 | drop `requireActor` | F11 |
| M4 | no transaction wrapper | F1, F2, F3, F4, F6, F8, F9, F10 |
| M5 | one `revokeGrant` for all grants | F3, F7 |
| M6 | `workspaceId: null` | F1, F3, F7 |
| M7 | blind extra primitive call on re-run | F7 |
| M8 | enumerate outside the transaction | F2, F4, F10 |
| M9 | exempt principal to `revokeGrant` only | **survives — NIT-1** |
| M10 | exempt principal to every primitive | F8, F9 |

## Reproduction

```
git worktree add --detach /tmp/tl2-136s2 c91a0719c
cp -al /tmp/tl2-136fix/server/node_modules /tmp/tl2-136s2/server/node_modules
cd /tmp/tl2-136s2/server && npx prisma generate
createdb: CREATE DATABASE t136s2 TEMPLATE t98b
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" STORAGE_DIR=$(mktemp -d) \
       SIG_KEY=$(openssl rand -hex 32) SIG_SALT=b API_KEY_PEPPER=$(openssl rand -hex 32) \
       JWT_SECRET=$(openssl rand -hex 32) \
       DATABASE_URL="postgresql://postgres:pw@127.0.0.1:55472/t136s2"
npx jest __tests__/security/authorization/offboardUserRepository.test.js --runInBand
```

Each mutant was a single-occurrence string replacement (uniqueness asserted before
writing), the suite re-run, then `git checkout -- ` before the next. The M9 probe ran as a
standalone script inside the worktree's `server/` directory and was deleted afterwards.
