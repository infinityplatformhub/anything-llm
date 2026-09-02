# Techlead-2 pre-read — #143 `91fb3549d` (plain tier)

**Skills invoked:** `requesting-code-review` — the plugin-namespaced form
(`superpowers:requesting-code-review`) does **not** resolve in this session either; both it
and the bare name return `Unknown skill`, so the reviewer template was read from disk at
`~/.claude/plugins/cache/superpowers-dev/superpowers/6.3.0/skills/requesting-code-review/`.
`infi-lessons` likewise does not resolve; the §7.17 line below is offered as text for
whoever owns that file. No `security-review`: plain tier, a test-harness guard.

**PASS.** Both questions answered by measurement. Two residuals to record, one of which the
ledger does not name.

Worktree `/tmp/tl2-143`. **Baseline 3 passed, 3 total.** Tree clean.

---

## Q1 — does the shape matcher reject nothing it should scan?

**It rejects 20 call sites, and all 20 are correctly out of scope.** I did not read the
regex and agree with it — I enumerated every `afterAll`/`afterEach` call site in the tree
and diffed against what the opener matches:

```
233 files | 164 afterAll/afterEach call sites | 144 matched by the opener
```

All 20 unmatched are **concise-body arrows with no braces**:
`afterEach(() => jest.restoreAllMocks())`, `afterAll(() => prisma.$disconnect())`,
`afterAll(() => console.log.mockRestore())`, and so on. The opener requires a `{`, so a
brace-less body cannot be matched — correct, since brace matching is what finds the hook's
extent.

**None of them does slow work.** Measured:

```
grep concise-body afterAll/afterEach whose text contains server.close or DROP DATABASE
 -> no matches outside hookTimeouts.test.js's own CONTROL sample
```

So the scanner's coverage over the tree as it stands today is complete. The single-shape
defect #143 exists to close is genuinely closed — the previously-missed
`removeAndUnembedHttp.test.js:90` is now matched, and reverting its `}, 60_000)` reds the
guard by name and line.

**Residual the ledger does not name.** A concise-body arrow that *did* do slow work —
`afterAll(() => server.close())` or `afterAll(() => admin.$executeRawUnsafe(\`DROP DATABASE …\`))`
— is invisible to this scanner. I built both and confirmed: 0 hooks found. Nothing in the
tree has that shape today, so this is not a defect, but it is the **same class** as the
single-shape gap #143 was filed for: a form that exists in the language, is not written
today, and is silently exempt. The ledger names the helper-indirection residual
(`afterAll(cb)` with `cb` elsewhere) and should name this one beside it — it is closer to
what someone would actually write.

## Q2 — does blanking handle block comments across lines, and strings containing `//`?

Both handled. Measured on six adversarial samples rather than reasoned about:

| case | result |
|---|---|
| multi-line `/* */` containing a full hook | blanked; only the real hook found (1) |
| string `"http://x//y"` then a real untimed hook | hook found (1) — the string's `//` blanks to end-of-line but the hook is on the next line |
| template literal `` `a // b` `` then a hook | hook found (1) |
| **string containing `/*`** | **0 hooks found — the real hook is swallowed** |

Line numbers are preserved (blank-with-spaces rather than delete), and the reported lines in
my mutant runs match the real hook lines, so that part works as claimed.

**The `/*`-in-a-string case is a genuine false negative**, and it is the one direction that
matters: a string literal containing `/*` opens a comment the blanker never sees as a
string, so everything to the next `*/` is blanked — including any real hook in between. That
is fail-**open**, unlike the `//` case which merely blanks the rest of one line.

I checked whether it is live: one file in the tree has `/*` inside a string
(`endpoints/preflightStepLogic.test.js:32`, `source.indexOf("/** A check that is not ok")`),
and that file contains **no** `afterAll`/`afterEach` at all — so no hook is currently hidden.
Not a defect today; worth one line in the file's own comment beside the existing
"this is a regex, not a parser" admission, because the consequence differs from the `//`
case and a reader should know which failure direction they have.

## Mutants fired

| mutation | result |
|---|---|
| revert `removeAndUnembedHttp:90` to untimed | **red**, named: `removeAndUnembedHttp.test.js:94 — closes an HTTP server in afterAll with no timeout` |
| remove comment blanking | **red ×2** — the offenders list and the comment CONTROL |
| opener back to the single `\(\)\s*=>\s*\{` shape | **red** — the every-shape CONTROL |

The third is the one that matters most: it is the #142 scanner exactly, and the new
per-shape CONTROL is what catches it. #142's CONTROL would not have — it covered only the
arrow form, which is precisely how the single-shape scanner shipped green over an untimed
hook. The ledger's own comment says this and it is true.

The blanking CONTROL ("a hook mentioned in a COMMENT is not a hook") records a measured
false kill rather than an anticipated one: the first version of the #143 fix comment
contained `afterAll(async () => {` as prose and the scanner matched it, then brace-matched
into the code beneath. A guard that fires on any file documenting its own rule is worse than
no guard, and it was found by running it.

## §7.17 line, offered

> A structural scanner's coverage is a measurement, not a claim: enumerate every call site
> the property could apply to and diff against what the matcher accepts. #143's opener
> matches 144 of 164 hook call sites; the 20 it skips are correct, but that is a fact you
> establish by counting, not by reading the regex.

## Verdict

**PASS.** Plain tier, gate-only per §7.11a. The two residual lines (concise-body arrows,
`/*` in a string) are comment additions, not code changes, and neither blocks.

## Reproduction

```
git worktree add --detach /tmp/tl2-143 91fb3549d
cp -al <donor>/server/node_modules /tmp/tl2-143/server/node_modules
cd /tmp/tl2-143/server && npx prisma generate
npx jest __tests__/utils/test/hookTimeouts.test.js --runInBand
```

The 164/144 inventory and the six blanking cases were run as standalone Python over
`__tests__/`, re-implementing `blank()` and the opener from the file, so the count is an
independent measurement rather than the guard agreeing with itself.
