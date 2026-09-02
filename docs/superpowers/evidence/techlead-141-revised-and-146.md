# Techlead-1 — recon-141 revised (`70a731126`): accept; and #146's guard (`e66ccbebd`)

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist — schema
constraint completeness (141), CI environment fidelity (146). `infi-lessons` not invoked.

§7.14: no suite run. Source reads in detached worktrees (`/tmp/tl-141`, `/tmp/tl-146`).

---

## (1) recon-141 `70a731126`: **accept, no objection**

Both findings corrected, and the correction is recorded as a correction — *"My first version of
this section named the wrong obstacle and proposed a fix that would have made things worse."* A
recon that says which of its own claims was wrong is worth more than one that quietly reads right.

The migration is the shape I ruled: third branch first, no `provider` match, empty string
load-bearing, no `DROP NOT NULL`, `appId` + `baseUrl` nullable, `COMMENT ON COLUMN` on each.

**Two things Dev2 added that I did not ask for, and both are right:**

- **`"appId" IS NULL` on the two existing branches.** Without it a row could be SAML *and* carry an app id — the half-of-each shape `092000` exists to reject, reintroduced by the very migration that extends it. I named the new branch's obligations and missed the old branches'. This is the more important half: a third branch that only adds a way to be valid widens the constraint, and widening is how a shape-derived CHECK stops meaning anything.
- **RF-3b** — the two existing shapes still save, and a two-shapes-at-once row is still refused. That is the test for the above, and it is the assertion a reviewer would otherwise take on trust.

**RF-3 naming the constraint** is the other improvement: a test that fails with
`identity_providers_one_shape` in the message tells the next reader what to edit, where "insert
failed" sends them to the column definitions.

## (2) #146 `e66ccbebd`: **the guard IS the contract for this issue, and Dev5 is right to say so plainly**

Measured and confirmed: `doctor.test.js` is 46/46 on both images because
`utils/doctor/index.js:287-296` demands `vector` only when `VECTOR_DB=pgvector`, and the suite's
own header says pgvector *"is NOT required and its absence is not a failure… a reviewer running
these against a database WITH pgvector and a developer running one without should both see green."*
That is deliberate and correct behaviour for a developer-facing preflight — and it is exactly why
it cannot witness a CI image change.

So the honest framing is Dev5's: **the contract proves the new image breaks nothing; the guard is
what holds the change in place. Two jobs, one witness.** I accept the guard as the evidence
contract for #146, on three grounds:

- **The mutation is real and named**: revert `ci.yml:16` → one red, the guard. Nothing else in the repo goes red, which is the finding, not a weakness.
- **It asserts the property, not the string.** `toMatch(/pgvector/)` rather than the literal tag, with the reason written down — pinning `pgvector/pgvector:pg16` would fail on a correct pg17 upgrade, which is how a guard earns deletion.
- **It targets the postgres service specifically** (`/postgres:\s*\n\s*image:\s*(\S+)/`), with a comment saying why matching any `image:` would pass on chroma/qdrant/weaviate/milvus. That is the vacuous-pass trap this program keeps finding, closed before it was hit.

**One correction to my own condition.** I said "observe it go red→green in CI, not reason about
it". Dev5 is right to refuse: pushing is outward-facing and their standing instruction is SHA-only.
The condition was mine to state and mine to mis-assign — **it belongs to PMO, not to the dev**, and
recording it as an open residual with "say the word and I push" is the correct disposition rather
than quietly marking it done.

The condition still stands, and it is not ceremony: `doctor.test.js` passing on both images means
**no test in this repo can distinguish the two environments**, so the only evidence that the new
image actually carries the extension in CI is a CI run. The guard proves the YAML says pgvector; a
run proves the image delivers it. **PMO pushes the branch and puts the run URL in the ledger before
#146 closes.**

## §7.17 candidate

**"A test can prove a change breaks nothing and still not witness it. Say which of the two a piece
of evidence is doing."** Measured on #146: 46/46 on both images, and the contract was read as
covering the change until someone checked.
