# QA-3 — issue #96, `dadac7b3c` (`approof/96-group-grants`) — PASS

Worktree `/tmp/qa3-96b` detached at `dadac7b3c`, own `yarn install`, own `prisma generate`,
database `qa3_96b` fresh (`migrate deploy` + `seed`, §7.1c). Node 22.

I measured the baseline defect myself on `main` `10dbbe818` before this SHA existed
(group holds `super_admin`, user has no direct grant → `no_grants`; same role granted
directly → `allowed_by_role`). Everything below is fired against the fix, with my own
probe scripts rather than Dev3's suite, so the two are independent.

`engine.test.js` on this SHA: **40/40**.

## The seven planned probes

```
P1  group grant -> authorize()            {"allowed":true,"reason":"allowed_by_role"}
P2a membership removed -> evaluate()      {"allowed":false,"reason":"no_grants"}
P2b grant removed instead -> evaluate()   {"allowed":false,"reason":"no_grants"}
P3  deny precedence, four directions:
      group-allow + group-deny            denied_by_role  ["role:1:49","role:8:49"]
      group-allow + direct-deny           denied_by_role
      direct-allow + group-deny           denied_by_role
      group-allow alone                   allowed_by_role
P4  cross-org: grant orgId=1 naming a group whose groups.orgId=2   -> no_grants
P7  service:single-user  allowed (holds a direct grant)
    service:api-key:7    no_grants        embed:embed:3  no_grants     — nothing threw
```

P3 needed a constructed deny row: the seed ships **zero** `role_permissions` with
`effect:"deny"`, so a precedence test written against seeded roles can never go red. I
raised that before the SHA and Dev3 built the fixture; confirmed here that all three
mixed directions deny and the allow-only control still allows, so the deny is doing the
work rather than the fixture being broken.

## The drift test — three paths, one fixture

Fixture shape: the user is a member of **wsA**, while only the **group** holds a grant, on
**wsB**. That separates "authority came from the group" from "scope came from membership",
which is exactly where a partial fix shows up.

```
D1 engine authorize(wsB via group grant)     allowed=true
D2 readableScope -> filter.workspaceIds=["wsB"], wsA absent, matchNone=false
   AGREES WITH ENGINE? true
D3 explainAccess -> [{principalType:"group",principalId:"1",effect:"allow",via:"manual",members:["1"]}]
D4 deny half: a deny row aimed at the group  -> document IS in deniedDocumentIds
D5 deny half, cross-org: deny aimed at the org-2 group -> NOT in deniedDocumentIds
```

Your note about `explainDocumentAccess` is right and I confirmed it: it reads
`document_acl`, never role grants, and asks the reverse question (given a grant row, who
does it cover). So the third path can only be compared through `buildDocumentFilter`.
D3/D4 are the pair that make it comparable — the same group id, allow visible through
`explainAccess`, deny visible through the filter.

## API-key ceiling (#35) — and a comment that contradicts its own code

With only the group holding the grant and the creator holding nothing directly:

```
K1 engine  user     allowed_by_role        api-key  no_grants     <- ruling: no group inheritance
K2 filter  user     workspaceIds ["1","3","5"]
           api-key  matchNone=true
K3 engine and filter AGREE for the api-key: true
```

The behaviour is right and both layers agree. But `readableScope`'s comment says:

> *An api-key actor is expanded here, unlike in the engine, ONLY because `grantPrincipal`
> is already the creator and this call passes it through unchanged*

The code immediately below it does the opposite — the `"grantPrincipal" in actor` branch
builds the bare pair and skips `grantPrincipalPairs`, identical to the engine. **The
comment is wrong, not the code.** Worth fixing before it misleads someone into "correcting"
the code to match: an api-key that inherited its creator's departments would widen whenever
someone edits a group, which is the thing the engine comment correctly refuses.

## Memo — counted through a real Prisma middleware

```
authorizeMany(100 resources)  group_members.findMany = 1
                              (permissions 100, principal_role_grants 100, role_permissions 100)
two separate authorize() calls  group_members.findMany = 2   (no cross-call cache)
one memo shared across userA/userB        A=true,  B=false
one memo shared across org1/org2, same user   org1=true, org2=false
```

The last two matter as much as the count: the memo key carries both org and user, so a
shared memo cannot answer for the wrong principal or the wrong org. Storing the in-flight
promise rather than the resolved array is what makes the 100-way `Promise.all` collapse to
one query — caching the result would have all 100 miss.

## Impersonation

My first attempt used `impersonated`; the real field is `impersonatedBy`, and the R5 guard
only bites on non-read actions. Corrected:

```
document.read    plain=allowed             impersonated=allowed
workspace.write  plain=allowed_by_role     impersonated=impersonated_mutation_denied
```

The guard runs before any policy lookup, so it makes no difference whether the authority
came from a group or a direct grant.

## Mutations

| id | mutation | result |
|---|---|---|
| G1 | engine stops expanding groups | **10 failed** |
| G2 | **`readableScope` stops expanding** (engine fixed, filter not) | **1 failed** — `drift: authorize, readableScope and explainAccess agree about one group member` |
| G3 | org join dropped from the helper | **1 failed** — `a group in ANOTHER org does not carry its grant across the boundary` |
| G4 | memo stores the resolved array instead of the in-flight promise | **1 failed** — `authorizeMany reads group membership ONCE for the whole batch` |
| G5 | api-key inherits creator groups | **1 failed** — `an API key does not inherit its creator's group grants` |
| G6 | user-type guard removed from `groupIdsFor` | **40 passed — survives** |

G2 is the one the ruling was about, and it is the single reason the drift test earns its
place: with the engine fixed and the filter not, `authorize()` permits a read the filter
then answers with nothing — an empty workspace rather than a refusal. Exactly one test
objects, and it is the one written for it.

### G6 — a surviving mutant I judged rather than escalated

Removing `principal.type !== "user"` from `groupIdsFor` changes nothing observable today,
and Dev3's `a service principal is not expanded, and never becomes NaN` still passes.
I checked why rather than assuming:

```
                       guard present    guard removed
service:core-jobs           []               []
embed:embed:3               []               []
service:api-key:7           []               []
```

`Number("core-jobs")` is `NaN`, `Number.isInteger(NaN)` is false, so the **second** guard
catches every real non-user principal — service ids are `core-jobs` / `api-key:<n>` and
embed ids are `embed_configs.uuid`, a `String` column. The type check is redundant *for the
ids that actually exist*.

It stops being redundant the moment a non-user principal has a numeric id:

```
                       guard present    guard removed
user:1                     ["1"]            ["1"]
workspace:1                  []             ["1"]     <- another principal's memberships
service:1                    []             ["1"]
embed:1                      []             ["1"]
```

`documentFilter:91` already builds `{principal_type:"workspace", principal_id:<workspaceId>}`
pairs, and workspace ids are integers — so a numeric-id principal type is not hypothetical,
it just does not reach `groupIdsFor` today. The guard is defence for a shape the codebase
already contains elsewhere. **Not a defect and not worth a SHA**: the code is correct, the
comment explains it correctly, and the mutation is unreachable through any current call
path. Recording it so nobody "simplifies" the guard away later on the grounds that a test
did not object.

## Residual

- `readableScope`'s api-key comment contradicts its code (above). Cosmetic, but it is the
  kind of comment that invites a wrong edit.
- `explainAccess` remains a fourth expansion by design (group → members, for display). The
  header says so explicitly. Three forward paths now share one helper; this one asks a
  different question and correctly does not.

## Files touched by me

None. All mutations were applied in `/tmp/qa3-96b` and reverted with `git checkout --`;
`git status` is clean at `dadac7b3c`.
