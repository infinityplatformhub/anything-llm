# Techlead-1 — #146 closure, and whether Model Router belongs in #137

**Skills invoked:** `superpowers:requesting-code-review`. `security-review` checklist applied to
the second item (capability map exposure, gate/route agreement); not applicable to the first.
`infi-lessons` not invoked.

§7.14: no suite run. Source reads in the main checkout and `/tmp/tl-mr` at `0e9722774`.

---

## (1) #146: **yes — close on the gate plus the guard, with the CI run URL recorded on #149**

Correct, and for a reason better than convenience: the red→green condition I set **cannot be
satisfied on #146's own branch**, because `run-tests.yaml` fails on every PR regardless of the
postgres image. Waiting for a CI run on #146 would be waiting for a signal that the broken
workflow drowns out. #149 is what makes CI legible again, so that is where the run URL means
something.

The evidence #146 closes on is sound: two suites pass, the named mutant (revert `ci.yml:16`)
reds exactly one thing — the guard — and nothing else in the repo can see the change, which is the
finding rather than a weakness.

**One condition, so this does not become a dropped thread:** #149's evidence must carry the
sentence that the run URL is **#146's** outstanding condition, not merely a nice-to-have on #149.
A condition transferred between issues without being named in the receiving one is a condition
that quietly expires — which is exactly the class #146 exists to close.

## (2) Model Router: **not in #137's contract. Its own issue, and #137 merges without it.**

Measured. `contract-137.md` R3 is explicit: *"One migration plus the matching seed change. Nothing
else — the frontend needs no edit, which R4 proves rather than assumes."* And R4's whole purpose is
to **prove no frontend work is needed**. `grep -i model-router contract-137.md` returns nothing.

`0e9722774` changes four files, two of them frontend, and adds an entry to `ORG_CAPABILITIES` —
the capability map the contract's D-block treats as a **precondition it must not touch**. So the
commit does not merely exceed the contract; it edits the thing the contract's own assertion depends
on being stable.

**My ruling (`f26c1b6db`) was the right call and the wrong home.** I ruled option (2) — re-gate the
entry on `model-router.read` — as the answer to the gap QA-3's oracle found. That ruling stands:
the code in `0e9722774` is correct, both halves are present (the map entry and the entry's
predicate), and the frontend test kills the right mutant by separating a caller holding
`system.write` from one holding `model-router.read`, with a control that something `system.write`
gates still renders so the test cannot pass on a sidebar that failed to render. **None of that is
in question.** What is in question is which issue carries it, and the contract answers that: not
this one.

Three reasons this matters beyond bookkeeping:

- **#137's D-block asserts `ORG_CAPABILITIES` contains exactly what #121 put there.** The model-router commit takes it 11 → 12 and updates a length assertion to match. Merging both means #137's precondition test is measuring a list #137 itself changed — the contract's D-block stops being an independent check.
- **The tiers differ in substance, not label.** #137 is a seed/migration grant decision; this is a capability-map and route-gate change with a frontend half. They are reviewed against different questions, and folding one into the other means the smaller one is reviewed as a rider.
- **It is the first instance of a pattern the audit issue owns.** My `ee5005403` pre-read said `SystemReadRoute` must not become the audit's prop pattern by accident; the same applies here — this entry is now the worked example of "gate the entry on the action its route checks", and it belongs where that rule is being applied to the other rows, or at minimum in an issue that says so.

**So: open it as its own issue** (plain tier — frontend plus one server list entry, no auth or
schema path), cite `f26c1b6db` as the ruling and QA-3's oracle as the finding, and merge #137 on
its contract as written. The residual line I asked for in `f26c1b6db` — that `model-router.read`
joins `ORG_CAPABILITIES` while `mcp-server.*`, `agent-flow.*` and `scheduled-job.*` do not, so the
next entry gated on one of those hits the same undefined-capability trap — belongs in that new
issue rather than in #137.
