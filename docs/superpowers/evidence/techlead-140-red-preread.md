# Techlead-1 — #140 RED pre-read (uncommitted, `/tmp/red140` on `2725752d7`)

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
unauthenticated information disclosure, authorization action correctness, fail-closed behaviour.
`infi-lessons` not invoked.

§7.14: no suite run. Read the two test files, the modified `endpoints/utils.js` and
`frontend/src/models/system.js`, and the sources they assert against.

---

## The five checks: all met, and three of them are met the hard way

**Unauth assertion is on the body key list, not the status.** Two separate tests — one for
`[401, 403]`, one asserting `DISCLOSING_FIELDS.filter(present)` is `[]`. The five field names are
declared once at the top so the 401 test and the member test cannot drift about what "discloses
something" means. The comment gives the right reason: `{"version": null}` still tells a caller the
field exists *and* that the instance is a source checkout that failed to read it.

**The `system.read`-only principal exists, and the mutant that motivated it is recorded.** The
fixture creates a bespoke role holding exactly one permission and grants it. The comment names
what would otherwise be unfalsifiable — every seeded role holding `system.read` also holds
`system.write`, so a gate on the wrong action passes everything — and states that mutant M4
(`action: "system.write"`) **survived the first cut 6/6 green**. That is the single most valuable
assertion in the file, and it exists because someone ran the mutant rather than reasoned about it.

**The frontend stub enforces the gate.** `vi.stubGlobal("fetch", …)` returns 401 when
`options?.headers?.Authorization` is missing. This is the check I would have insisted on: with an
always-200 stub, `fetchAppVersion`'s `.catch(() => null)` makes the footer test green while the
real browser call 401s and the footer silently blanks — "a control that could not fail, which is
worse than no control", as the comment puts it. Correct.

**Fetch call count asserted, and the cache is cleared for a stated reason.** `fetchCalls.length`
is pinned to 1 in both later tests, and `beforeEach` clears `localStorage` because
`fetchAppVersion` caches for an hour — without which the second test would assert a header against
**zero** requests and pass vacuously. Named in the comment.

**Docker `--` vs source 40-hex pinned.** `withRuntime` sets and restores
`ANYTHING_LLM_RUNTIME` in a `finally`, so the two cases cannot leak into each other, and the
source case asserts `/^[0-9a-f]{40}$/` — the disclosure the issue exists for, pinned by a test
rather than by the recon's prose.

## TL-2's ruling, as implemented in the uncommitted source

`validatedRequest` is on the whole route (`utils.js:29`) and `storage` is decided in the handler
by `callerMaySeeStorage` (`:124-144`), omitted rather than nulled — both halves as ruled, one
route not two. `catch → return false` is fail-closed, which is right: an engine error must not
disclose disk figures.

## Two things to fold in — neither blocks RED

**1. Nothing pins that `storage` is absent for an ANONYMOUS caller specifically.** Describe A
asserts the five fields are absent from a *rejection body*, which is satisfied by any 401 with an
empty body. That is fine today because the route is gated — but it means the whole disclosure
claim rests on `validatedRequest` staying on the route. A mutation that removes `validatedRequest`
and leaves `callerMaySeeStorage` in place produces a 200 with `version`, `mode`, `vectorDB`,
`appVersion` and no `storage` — and **describe A's second test still passes**, because it only
checks the body it happens to get. Only the status test catches it, and status is exactly what the
brief says the assertion should not rest on.

```
RF-A3 : an unauthenticated GET returns none of the DISCLOSING_FIELDS *and* the
        status is a rejection — asserted as one test, so neither half can be
        satisfied while the other fails
mut   : remove `validatedRequest`, keep callerMaySeeStorage
why   : the current split lets the key-list assertion pass on a 200 that discloses
        four of the five fields. The fields are the point; the status is how you
        know which body you are looking at.
```

**2. `callerMaySeeStorage` constructs a new `DatabaseAuthorizationEngine` per request.** Every
other in-handler user (`admin.js:59`, `browserExtension.js:18`, `chat.js:24`) builds one at module
scope. Not a correctness bug — `engine.js:57` holds only `db`, and the memo at `:130` is
per-call by design — but it is a gratuitous divergence from four sibling files, and the `require`
inside the function body is the shape that hides a cycle rather than avoiding one. Move both to
module scope unless there is a load-order reason, in which case say so in a comment; this module
already documents one such cycle elsewhere.

## Verdict on the pre-read

Ready to go RED. The M4 record, the gate-enforcing stub and the cache-clearing rationale are the
three things that make this suite hard to satisfy accidentally. Fold in RF-A3, and move the engine
construction to module scope.
