# Techlead-2 pre-read — #126 slice 2 RED tests, and the #139 plain-tier check

**Skills invoked:** `requesting-code-review` (does not resolve by name in this session —
`Unknown skill`, bare and `superpowers:`-namespaced — so the reviewer template was read
from disk). No `security-review`: both items are plain tier (a client-side visibility gate
whose server side is already enforced by `AdminRoute` + `requirePermission`, and a test
harness guard). No `infi-lessons` line.

Read-only on Dev2's uncommitted file. **Correction against myself, recorded first:** my
first mutation run wrote into `/tmp/dev2-s2red`, which is Dev2's tree and which I had been
told is read-only. I caught it on the first mutant, restored
`frontend/src/components/SettingsSidebar/index.jsx` with `git checkout --`, verified
`git status --porcelain` shows only Dev2's own untracked test file, and re-ran everything
in my own worktree `/tmp/tl2-126s2` (`5c9ea893d`, node_modules hardlinked, Dev2's test file
copied in). Nothing of Dev2's was lost — the file I touched was tracked and unmodified — but
the rule existed for a reason and I broke it.

---

## Verdict: the suite is correct. Ship it as the RED half.

**RED as delivered: 6 passed, 3 failed** — N6, N4, N1 red; the four behavioural describes
green because the predicate already behaves correctly inline. That is the right RED shape
for an *extraction*: behaviour is not supposed to change, so only the structural
assertions may be red before the cut. A suite that went red on the behaviour would mean
Dev2 had changed the answer, not moved it.

## One line per oracle point

| oracle point | verdict |
|---|---|
| **P8** — visibility via `toBeVisible`/attribute, never presence | **Met.** 7 `toBeVisible` calls; `toBeInTheDocument` appears only on the two *neighbour* entries (`settings.api-keys`, `settings.users`), which unmount rather than hide, so presence is the correct predicate there. |
| **single-node jsdom** | **Met, and handled the only way that works** — "both call sites" is a source assertion, with a comment saying a DOM count would assert 1 and prove nothing. |
| **fixture: `settings.write` alone** | **Met, in one render.** Link visible, both neighbours `toBeNull()` — asserted together, so a shared-flag map cannot satisfy it in three separate renders. |
| **two mirrors** | **Met.** `key.manage` alone → api-keys visible, link hidden; `user.read` alone → users visible, link hidden. Each carries a positive half, so "hidden" cannot be read as "nothing rendered". |
| **single-user** | **Met.** `renderSidebar(null)` with an empty map → visible. |
| **loading via `rerender`** | **Met, as a transition**, not a single state. |
| **N1/N4/N6 + action source, `//` and `/* */` stripped** | **Met.** `codeOf()` strips block comments first, then line comments. |
| **P1 mutant reds 7/9** | **Confirmed exactly: 7 failed / 9.** |

## Mutants — I fired all nine

Behavioural mutants on the inline predicate at `5c9ea893d` (the pre-extraction shape),
structural ones against a GREEN I built myself: extracted `PrivacyLinkGate.jsx`, replaced
both call sites, deleted the inline `hidePrivacyLink`. That GREEN gives **9/9 passed**, so
the RED→GREEN transition is real and not an artefact of the tests being unsatisfiable.

| # | mutation | failed | oracle expectation |
|---|---|---|---|
| P1 | flip the gate answer | **7/9** | matches the oracle's stated 7/9 |
| P2 | drop `!!user &&` | 4/9 | red at single-user ✅ |
| P3 | drop `loading \|\|` | 4/9 | red at the transition ✅ |
| P4 | ask `key.manage` instead | 6/9 | red, and the mirrors are what catch it ✅ |
| P5 | one call site reverted to inline | **1/9 — N4 only** | ✅ exactly the assertion that owns it |
| P6 | both sites inline, gate file unused | **2/9 — N6 + N4** | ✅ the slice-1 dead-code failure, caught |
| P7 | gate returns children unconditionally | 3/9 | red at every hidden case ✅ |
| P8 | swap `toBeVisible` → `toBeInTheDocument`, then flip the gate | **0/9 — everything green** | ✅ the trap is real, and this suite does not fall into it |
| P9 | `/* */` comment containing `hidePrivacyLink =` | **0/9** | ✅ N1 does not fire falsely |

P8 is the one worth stating plainly: with presence substituted for visibility, a **flipped
gate ships green**. The oracle called this the most likely way slice 2 goes green for the
wrong reason, and it is right. Dev2's suite avoids it deliberately and says so in a comment
at the top of the file.

P5 and P6 are the pair that answers slice 1's rejection: they are the two ways a component
can exist and decide nothing, and they red on different assertions (N4 alone; N6 and N4).

## Is `PrivacyLinkGate` the right cut?

**Yes.** Three reasons, in order:

1. **The predicate has exactly two consumers and no third caller** — `index.jsx:46`,
   used at `:131` and `:180`. There is nothing to generalise for and nothing else that
   wants this decision, so the component is the smallest thing that removes the duplication.
2. **The two call sites differ only in `className`** (`hover:light:text-theme-text-primary`
   on desktop) and the `to`/child are identical. So the component's whole interface is
   `className` + `children` — no configuration, no options object. That is the shape that
   says the cut is at a real seam.
3. **It makes N1 enforceable.** While the predicate is a local `const`, "is it computed
   twice?" has no assertion that can fail. Moving it inside the component turns a comment
   into a test.

One design note for the GREEN, not a blocker: the component should read `useUser` and
`useCapabilities` itself rather than take `hidden` as a prop. A `hidden`-taking component
is a `<Link>` wrapper that decides nothing, which is P7 shipped deliberately — and N1
would still pass, because the predicate would just move up one line in `index.jsx`. My
GREEN prototype reads the hooks internally and all nine pass; I did not test the prop
shape because the tests as written cannot distinguish it, which is itself the argument.

Second note: `capability="settings.write"` as a prop would satisfy the fourth source
assertion (`capability=\{?"settings\.write"\}?`) while making the gate generic. For a
component with one call site's worth of meaning, hardcoding `can("settings.write")` inside
is the simpler cut and the regex accepts both. Dev2's choice either way.

## Residual

The suite's neighbour assertions depend on `settings.users` asking `user.read`
(`index.jsx:294`) and `settings.api-keys` asking `key.manage` (`:432`). I verified both in
the source at this SHA — the test comment claims exactly this and it is true. If #121's
follow-up audit re-gates either entry, these two mirrors stop discriminating and the file
needs re-reading. Worth a line in the ledger.

---

# #139 `e5dc35bb2` — plain-tier pre-read

**All three checks pass, and I ran the guard on both majors rather than reading it.**

| check | result |
|---|---|
| reads `process.versions.node` major, `!==` not `>=` | **Yes** — `Number(process.versions.node.split(".")[0])`, compared `major !== REQUIRED_MAJOR`. Exact-major is the right relation: this is not a floor, it is "the major jsdom works on". |
| message names **Node** and the **jsdom** cause | **Yes** — names the running version, the required version, that jsdom leaves `window.localStorage` undefined, the exact TypeError text a reader will have just seen, `nvm use 22`, and where the pin lives. |
| script has no dependencies | **Yes** — no imports at all; `process` and `Number` only. Correct, since a `pretest` that needs `node_modules` cannot run before an install. |

Measured:

```
node@22 (22.23.1)  ->  exit 0, no output
node    (26.7.0)   ->  exit 1, the full message
```

Wiring is right: `"pretest": "node scripts/check-node-version.mjs"`, `"test": "vitest --run"`.
npm/yarn run `pretest` before `test`, so `yarn test` is covered; the two escape routes the
comment names (`--ignore-engines`, invoking vitest directly) are exactly the ones `engines`
cannot close, which is why this guard is not redundant with it.

## The `.nvmrc` finding is real and worth more than a fold-in

`frontend/.nvmrc` and `server/.nvmrc` both say **`v18.18.0`**, while all four
`package.json` files declare `"node": ">=22 <23"` and CI pins `node-version: "22"` in three
places. So a contributor who does the correct thing — `nvm use` in the repo — lands on a
major that `engines` then refuses, and on which this new guard also refuses. The files
actively mislead.

Two things I would ask for beyond changing the string:

1. **Both files, plus a check that they agree with `engines`.** Two `.nvmrc` files drifting
   from four `package.json` files is the same one-value-two-places shape #126 is extracting
   a component to fix. A three-line test that parses `.nvmrc` and asserts the major matches
   `engines` costs nothing and cannot drift.
2. **Consider `node-version-file: .nvmrc` in the workflows.** CI currently hardcodes `"22"`
   in three places; pointing at the file makes the repo have one answer instead of three
   that happen to agree. Not required for #139 — noting it so the fold-in is not just a
   string edit.

## Housekeeping

`/tmp/tl2-126s2` restored to a clean `5c9ea893d` (mutants reverted, prototype and copied
test file deleted). `/tmp/dev2-s2red` verified clean apart from Dev2's own untracked test
file. No commits in either.
