# Techlead-2 pre-read — #142 `f96a95024` (plain tier)

**Skills invoked:** `requesting-code-review` (does not resolve by name in this session —
`Unknown skill`, bare and `superpowers:`-namespaced — so the reviewer template was read
from disk). No `security-review`: plain tier, a test-harness guard with no authorization
surface. No `infi-lessons` line.

**All three checks pass.** One scope observation that is worth a comment line, not a fix.

Worktree `/tmp/tl2-142`, own database. Guard baseline: **2 passed, 2 total.** Tree clean.

---

## 1. Comment-stripped and non-vacuous?

**Non-vacuous: yes, and by the right mechanism.** The CONTROL test holds a two-hook sample
and asserts `hooks).toHaveLength(2)`, that the first is slow-and-untimed and the second is
slow-and-timed. So a matcher returning nothing fails the CONTROL rather than passing the
main test forever.

I fired the mutant rather than reading it — **M2**, break the opener regex so the scanner
finds no hooks at all:

```
✕ CONTROL: the matcher actually finds an untimed slow hook
```

The main assertion goes green under that mutation, exactly as the comment predicts, and
the CONTROL is what catches it. That is the §7.17 vacuous-green class, correctly closed.

**Comment-stripped: no, and it does not need to be here** — this is a deviation from the
usual rule, so it needs a reason rather than a pass. Every other source assertion I have
ruled on strips comments because the thing being searched for is a *string that could
appear in prose* (`AdminRoute`, `hidePrivacyLink`). This scanner searches for
`DROP DATABASE` / `server.close` inside a **brace-matched hook body**, and then for a
timeout argument in the 20 characters after the closing brace. A comment can only produce
a false *positive* here — a hook whose body mentions `DROP DATABASE` in a comment but does
not do it — which reports a violation that a human then dismisses. It cannot produce a
false negative, because a commented-out timeout is not a timeout. Failing noisy rather
than failing open is the right direction for a guard, so the omission is safe.

The file names its own limit honestly: it skips itself, because its CONTROL holds a sample
hook as a string literal that a text scanner cannot distinguish from a real one. Stating
that beats a scanner that parses JavaScript for one guard.

**The brace matching is the right instrument.** The comment gives the reason — a lazy
`[\s\S]*?\}` stops at the first inner brace and reads the timeout off the wrong closing
paren. That is the same failure class as #132's text-delimiter extraction, and it is
avoided the same way.

## 2. Are the two edited hooks the only violators today?

**Yes.** I re-implemented the scanner standalone and ran it over the whole tree rather
than trusting a grep:

```
afterAll hooks total=87   slow=42   timed=42   untimed=0
```

42 hooks do slow external work; all 42 now carry a timeout. Before the change, the two
named in the ledger (`assignableRolesHttp:176`, `offboardUser:376`) were the only two
missing one. Confirmed.

**Mutant:** remove one of the two timeouts →

```
✕ every such afterAll passes an explicit timeout argument
+   "security/authorization/offboardUser.test.js:379 — closes an HTTP server with no
     timeout (jest default is 5s)"
```

Red, and the message names the file, the line and the reason. That is the "named, not
counted" property the file claims, and it holds: a reader who has never seen this failure
gets told where it is, which matters more here than usual because — as the ledger
documents — the symptom is `Test suite failed to run` with every test passing, which reads
like an import crash.

## 3. Scope observation (comment, not fix)

The opener regex is `afterAll(\s*async\s*(\s*)\s*=>\s*{`, so it matches **only** the
`afterAll(async () => {` shape. Three other shapes exist in the tree, and two of them do
slow work:

```
endpoints/removeAndUnembedHttp.test.js:90   afterAll((done) => { server.close(done) })   — UNTIMED
endpoints/t4aRouteIdor.test.js:86           afterAll((done) => { server.close(done) }, 60_000)
```

`t4aRouteIdor` already carries `60_000`, so it would pass anyway. **`removeAndUnembedHttp`
is a genuine untimed `server.close` teardown that this guard does not see** — a
callback-style hook rather than an async arrow.

I am not asking for it to be fixed in #142: `server.close(done)` with `closeAllConnections`
first is the fast path, the issue was filed about the two async hooks, and widening the
matcher to cover callback and `function` forms is a larger change than the guard warrants.
But the guard's name promises more than it delivers, and the next person will read
`offenders).toEqual([])` as "no untimed slow teardowns exist". One line in the file saying
the scanner covers the `async () =>` shape only — and that callback-style hooks are
unchecked — makes the claim match the code. Cheap now, invisible later.

Also worth one line: `afterEach` is not scanned at all. No `afterEach` in the tree does
`DROP DATABASE` today (42 files contain the string; all in `afterAll`), so there is nothing
to fix — but the same "the guard covers what it covers" note applies.

## The ledger's central claim, checked

The ledger says the original report — `jsonwebtoken` failing to load on node 22 via
`buffer-equal-constant-time` reading `SlowBuffer.prototype` — was **not** the defect, and
that under jest's `node` environment `require("buffer").SlowBuffer` is a function with a
prototype. That matters because it means the fix is in the right place: had the import
theory been true, a hook timeout would have been treating a symptom.

The evidence given for it is the right kind — the two suites named in that report run 18
and 11 tests respectively, which an import failure would not permit. A suite that cannot
import runs zero tests. That is a sound disproof and it does not require me to reproduce
the node-version claim to accept the conclusion.

## Verdict

Plain tier, gate-only per §7.11a. Nothing here blocks. The two comment lines in section 3
are worth folding in before merge; neither changes behaviour.

## Reproduction

```
git worktree add --detach /tmp/tl2-142 f96a95024
cp -al /tmp/tl2-138q/server/node_modules /tmp/tl2-142/server/node_modules
cd /tmp/tl2-142/server && npx prisma generate
export PATH="/opt/homebrew/opt/node@22/bin:$PATH" ... DATABASE_URL=...
npx jest __tests__/utils/test/hookTimeouts.test.js --runInBand
```

The 87/42/42 inventory came from a standalone re-implementation of `afterAllHooks` and the
`SLOW` filter run over `__tests__/`, not from the guard itself, so the count is an
independent measurement rather than the same code agreeing with itself.
