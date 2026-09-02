# Techlead-1 — #40 task 2 `3e121b3b4` delta (from `36b110a8d`, my PASS)

Delta: 3 files, +301/-34 — endpoint (+54/-34), test file (+261), ledger. Probes in detached
worktree `/tmp/tl1-t2b` against a live PostgreSQL; no suite run (§7.14).

**Verdict: PASS, no findings.** Every item I raised is closed, and each is closed with a
mutation I could make go red rather than an assertion I had to take on trust.

## The guard is now the thing the test proves

`workspaceCapabilities:47` is `if (actor?.type !== "user" || !user?.id) return null;` — type
first, before any lookup, with the reason written above it. Mutated it back to `!user?.id`
alone and drove the three non-user actor shapes:

```
M-A (no type guard)  service      -> lookups: 1   RED
M-A (no type guard)  single-user  -> lookups: 1   RED
M-A (no type guard)  embed        -> lookups: 1   RED
```

The lookup **runs** under the mutation, which is what the new unit test at
`the actor-shape guard stops before the database` asserts against with a `jest.spyOn` and an
engine that throws if touched. It drives four actor shapes **and** five user shapes
(`undefined`/`null`/`{}`/`{id:null}`/`{id:undefined}`), and includes a `service` actor
carrying a `grantPrincipal` — so a guard keyed on `grantPrincipal` fails it. That is the
specific bug I named in my pre-read F5, now pinned.

The comment above the guard states the measured fact (Prisma drops `undefined`, leaving
`some: {}`, which matches every populated workspace) and says it was **verified against
postgres, not reasoned about**. The ledger correction at `ledger-40.md:277` is honest about
the earlier reason being wrong and explains *why* M4b was weak — the tests were weak, not the
code strong. That is the right way to record a correction; a reader following the old
sentence would have removed a guard elsewhere.

Ledger `:285` also records the mutation delta this produced: guard removed → 2/12 red (was
1/11); guard weakened to `user === undefined` → 1/12 red (was fully green). The weakened-form
number is the more valuable of the two.

## QA-1 F5 — the shape guard, verified

`:13` requires `typeof workspaceId === "string"` before anything else. Probed the real
function:

| input | result | lookups |
|---|---|---|
| `["7"]` (express `?workspaceId[]=`) | `null` | **0** |
| `{x:"7"}` (`?workspaceId[x]=`) | `null` | **0** |
| `7` (number) | `null` | 0 |
| `"7"` | answered | 1 |

Removing the guard: an array reaches the lookup and the endpoint **answers with the
workspace** (`{"id":7}`, 1 lookup) — test red. The paired test "an array carrying the
caller's OWN workspace id is still refused" is the one that matters: it proves the *shape* is
refused rather than the value happening not to resolve.

## QA-1 F3 — `actor?.orgId ?? 1`

Confirmed independently that `workspaces` carries no `orgId` column (`schema.prisma`), so the
row genuinely cannot supply one and the actor is the only source. Mutated back to the literal:

```
M-B (literal orgId)  recorded orgId: [1]  -> RED
```

The recording-engine test asserts the value the engine actually received rather than
inspecting the resource object, which is the right level. The residual is stated in the code
comment (`:58-60`) and in PMO's message: with no `orgId` on the row, nothing ties *this*
workspace to that org, so cross-tenant separation still rests on membership alone, and closing
it needs a schema change. Correct framing — the fix makes the endpoint agree with the engine,
which is a real improvement, and it does not claim to be tenant isolation.

## My remaining pre-read findings

- **F1** — closed twice over. The stub-reject unit tests were already there; this SHA adds
  "an org capability is never answered in the workspace half", which is the second half of
  what I asked for (mutation B in my pre-read): the two vocabularies cannot bleed, so an
  org-wide grant cannot report a workspace affordance. And "an org-wide grant does not make a
  non-member workspace visible" pins the consequence I asked to be pinned rather than the
  rule.
- **F4** — closed. Both fixtures I asked for: the write-shaped capabilities come back false
  under `impersonated_mutation_denied` (derived from `READ_ACTIONS` rather than hardcoded, so
  the test follows the engine if that set changes), and view-as does not widen visibility to
  the impersonator's workspaces.
- **F5** — closed as a string guard here and deferred to #103 for the grantPrincipal
  question, which is the right split.
- **The ordering note** — taken. `system.js:1597-1602` now says the separation is **order
  plus a private catch**, and that sharing one try/catch reintroduces the failure. That was my
  one structural worry on the previous SHA.

## Nothing outstanding

No NITs. The anonymous-caller observation from my last review is unchanged and remains a
harmless regression pin.
