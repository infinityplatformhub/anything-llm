# QA-3 — #126 slice 2 oracle (privacy link → renderable component)

Measured on `/tmp/qa3-127` @ `5c9ea893d` with the real `SettingsSidebar`, capability maps
built from `qa3_121`'s seeded grants. Written before Dev2's SHA.

## 0. What the code does today

```js
// SettingsSidebar/index.jsx:46
const hidePrivacyLink = !!user && (loading || !can("settings.write"));
```

used at **two** call sites — `:131` (mobile) and `:180` (desktop) — as `hidden={hidePrivacyLink}`
on a `<Link to={paths.settings.privacy()}>`. Same shape as slice 1's Home gate, and the
same trap: one predicate, two call sites, and the ledger already records that slice 2 must
keep the "both call sites use one value" assertion because a gate render test cannot reach it.

**Note for the fixture author**: the link is always in the DOM. It is hidden by the
`hidden` attribute, not unmounted. `queryByText("settings.privacy")` therefore returns a
node in *every* state — a test asserting `.toBeInTheDocument()` passes for a denied user.
Visibility must be read off the attribute (or `toBeVisible()`), never off presence. This is
the single most likely way slice 2's suite is green for the wrong reason.

Also: only **one** node is in the tree at a time under jsdom (the mobile/desktop branches
are mutually exclusive at the rendered width), so a test that expects two nodes will fail
for reasons unrelated to the gate.

## 1. Exact visible set, per role

| fixture | privacy link | `settings.users` | `settings.api-keys` |
|---|---|---|---|
| `super_admin` | **visible** | yes | yes |
| `setup_admin` | **visible** | yes | yes |
| `content_moderator` | hidden | no | no |
| `member` | hidden | no | no |
| **only `settings.write`** | **visible** | **no** | **no** |
| only `key.manage` | hidden | no | **yes** |
| only `user.read` | hidden | **yes** | no |
| **single-user (no user row)** | **visible** | no | yes |
| `settings.write` **+ loading** | **hidden** | no | no |

So: visible exactly to `settings.write` holders (`setup_admin`, `super_admin`) and to
single-user; hidden while loading even for a holder. That matches `hidePrivacyLink` and is
the table Dev2's suite has to reproduce.

## 2. The fixture Dev2 must write (PMO's item 2)

**Positive, one capability at a time:**

- hold **`settings.write` alone** → privacy link **visible**, and `settings.users`
  (`user.read`, `index.jsx:302`) **absent**, and `settings.api-keys` (`key.manage`, `:440`)
  **absent**. Verified above: that fixture yields `users=false apiKeys=false`, so both
  neighbours are real discriminators, not accidental.
- **mirror**: hold **`key.manage` alone** → privacy link **hidden**, `settings.api-keys`
  **visible**. And hold **`user.read` alone** → privacy link **hidden**, `settings.users`
  **visible**. Each mirror proves the fixture reached the privacy gate and not a sibling —
  a map that lit up everything would satisfy the positive case alone.

**Single-user**: no user row → visible with an empty map. `!!user &&` is the disjunct; a
gate asked only about the capability locks the sole operator out of their own settings.

**Loading**: `settings.write` held **and** `loading: true` → hidden, then visible when
loading resolves. Assert the **transition** via `rerender`, not the loading state alone —
`loading` and `denied` render identically, so a single-state assertion passes for a gate
that never distinguishes them. (This is the ruling Dev2 already recorded in slice 1's
ledger; it applies unchanged.)

## 3. The call-site assertion (PMO's item 3 — why slice 1 was rejected)

Slice 1 shipped a suite that mounted `WorkspaceGate` directly and left `Home`'s use of it
untested: I made the component **dead code** and 93 tests stayed green. The fix that landed
was a comment-stripped source assertion. Slice 2 needs the same guard, adapted:

```js
const source = readFileSync(`${__dirname}/index.jsx`, "utf8")
  .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

// N6: the component is used at all
expect(source).toMatch(/<PrivacyLinkGate/);
// N4: BOTH call sites go through it — mobile and desktop
expect(source.match(/<PrivacyLinkGate/g)).toHaveLength(2);
// N1: the predicate is not also computed inline, where two copies drift
expect(source).not.toMatch(/hidePrivacyLink\s*=/);
// the capability the gate is asked about is the one the route enforces
expect(source).toMatch(/capability=\{?"settings\.write"\}?|can\("settings\.write"\)/);
```

Strip `//` before matching (§7.17). **Also strip `/* */`** — that is the residual I found
on slice 1 (`df7d54f72`): a block comment containing the predicate text trips the N1
assertion falsely. It fails closed, so it is not a defect, but slice 2 can close it for free.

## 4. Mutants I will fire (PMO's item 4)

| # | mutation | must |
|---|---|---|
| P1 | flip the gate answer (`!can(...)` → `can(...)`) | red — holders lose the link, non-holders gain it |
| P2 | extraction changes the predicate: drop `!!user &&` | red at single-user |
| P3 | drop `loading \|\|` | red at the loading→resolved transition |
| P4 | gate asks `key.manage` instead of `settings.write` | red — and the mirror fixtures are what catch it |
| **P5** | **component not rendered**: revert one call site to the inline `hidden={...}` | red at the call-site count (N4) |
| **P6** | **component not rendered at all**: both sites inline, gate file present but unused | red at N6 |
| P7 | gate returns `children` unconditionally (renders, decides nothing) | red at every hidden case |
| P8 | assert-only-presence trap: if the suite uses `toBeInTheDocument`, P1 **survives** | this is the check on the suite, not the code — I will run it |
| P9 | `/* */` block comment containing `hidePrivacyLink =` | N1 must not fire falsely (the slice-1 residual) |

P8 is the one I expect to matter most, given §0: presence is not visibility here.

## 5. Sequencing

Fire on Dev2's SHA **after #121 merges** — `SettingsSidebar/index.jsx` is #121's file and
slice 2 edits it, so probing before the merge measures a tree that will not exist.

## Housekeeping

Probe test file deleted; `/tmp/qa3-127` `git status --porcelain` clean. No commits.
