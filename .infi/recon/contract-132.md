# #132 contract — a client guard that asks `system.read`

Base `origin/approof/main`. Ruling-independent prep only; **no code**. The route list in §4 is a
placeholder that TL-2's (ก) fills. Every claim below was produced by running something, and the
harness that produced §2 is committed beside this file as `pbleed-132.cjs`.

Prerequisite, unchanged: `system.read` must be in `ORG_CAPABILITIES` before any guard asks for
it, or the guard refuses **every** caller including `super_admin` and the page is unreachable.
Verified present at #121's `6e205d79b` **by running** the set-intersection, not by reading the
diff. To be re-run against the merged main SHA before any code, because a merge can drop a hunk
— which has happened once already this cycle.

---

## 1. What the guard is for

`setup_admin:org` holds `settings.write` and **not** `system.read`. `AdminRoute` gates on
`can("settings.write")`, so that principal passes the guard, reaches
`/settings/mobile-connections`, and gets 403 from both of the page's routes
(`endpoints/mobile/index.js:21,86`, both `requirePermission("system.read", orgResource)`).
#127 narrowed the bug from `manager` to `setup_admin`; it did not close it.

---

## 2. The route-table assertion, designed against QA-3's P-bleed set

The shipped #127 assertion locates the route with a **text delimiter**:

```js
const routeStart = source.indexOf('path: "/settings/mobile-connections"');
const block = source.slice(routeStart);
const routeEnd = block.indexOf("},\n      {");   // ← the weak point
const routeBlock = block.slice(0, routeEnd);
```

Run against the P-bleed set, it does hold — but only because of the offset guards QA-3 forced in:

| mutation | shipped assertion |
|---|---|
| route de-guarded | RED |
| delimiter broken (reflow) | RED at the offset guard |
| both | RED at the offset guard |

It never passes wrongly, but two of the three reds are the *offset guard* firing, not the
assertion. A test whose failure mode is "my extraction broke" on an ordinary prettier run is a
test the next person deletes. **`indexOf` returning -1 into `slice(0, -1)` is the original
fail-open**; asserting the offset converts it to fail-noisy, which is correct but not stable.

**Design for #132: brace-balanced extraction, no text delimiter anywhere.** Find the path
literal, walk back to the `{` that opens its object, walk forward to the matching `}`. Then strip
line comments and assert on code only. Measured results (`node .infi/recon/pbleed-132.cjs`):

| # | mutation | verdict |
|---|---|---|
| — | baseline, post-fix | GREEN |
| P1 | route de-guarded (`<MobileConnections />`) | RED(guard) |
| P2 | reverted to `AdminRoute` | RED(guard) |
| P3 | delimiter / indentation reflow | **GREEN** — survives, where the shipped one dies |
| P4 | de-guarded **and** expected text planted below the block | RED(guard) |
| P5 | de-guarded **and** expected text planted in a comment *inside* the block | RED(guard) |
| P6 | route path renamed away | RED(path literal not found) |
| P7 | whole route block deleted | RED(path literal not found) |

Three properties earn their place, each because a mutation above needs it:

1. **No text delimiter.** P3 is a formatting change, not a behaviour change; the assertion must
   not care. Brace matching is the file's real structure.
2. **Comment stripping must remove TRAILING `//`, not just full-line.** My first version stripped
   `/^\s*\/\/.*$/` and **P5 passed** — the guard name planted in a trailing comment beside
   de-guarded code satisfied the regex. Caught by running P5, not by reading the strip.
   (Safe here because `main.jsx` contains zero `//` inside string literals — asserted, not
   assumed, since the strip is a regex and not a parser.)
3. **Assert the block spans exactly one route** (`path: "` occurs once after stripping). This is
   the structural equivalent of the offset guard: if brace matching ever grabs a parent array,
   the assertion must say so rather than search a wider region and find a guard belonging to a
   different route.

Failures return a *reason string*, never a degraded slice. Every one of P1-P7 names which
property broke.

---

## 3. The `FullScreenLoader` line — decided, and the decision is "inherited, untested"

`AdminRoute` and `ManagerRoute` both carry:

```js
if (multiUserMode && capabilitiesLoading) return <FullScreenLoader />;
```

**Decision: `SystemReadRoute` copies it.** Reason: without it the guard can decide against a
principal before the capability map arrives, and a wrong redirect is not recoverable by waiting
— the user lands on home and must navigate back — whereas a late-appearing page is a flicker.
That asymmetry is the whole reason the line exists.

**It ships marked `inherited-untested` (#127 G3), not "covered".** Measured, not assumed:
deleting `AdminRoute`'s copy of the line leaves **adminRoute.test.jsx 9/9 and
mobileConnectionsGuard.test.jsx 6/6 — 15/15 green.**

The reason is in the source comment already: the line is reachable only if the session check
settles *before* the capability map, and `isAuthd === null` holds the route through most of that
window. `adminRoute.test.jsx:205` ("the guard waits rather than redirecting") does exercise a
deferred map and is a real test — but it passes with the line deleted, because the `isAuthd`
gate covers for it. **Two guards covering for each other**, the #49 clock-skew shape exactly.

Writing a test for it would mean driving `useIsAuthenticated`'s internals to force the two async
sources to settle in an order production does not guarantee — which tests the mock, not the
guard. So: copy the line, carry the reason, and label it honestly. A line marked
`inherited-untested` is a known gap; the same line called "covered" is a false claim, and the
next person to touch it deletes it on the strength of a green suite.

---

## 4. Tests (RED before GREEN, each mutation run)

Route list placeholder — **filled by TL-2's (ก)**; the shape below holds for whatever routes (ก)
names.

| # | assertion | why it cannot pass vacuously |
|---|---|---|
| R1 | `setup_admin` (holds `settings.write`, not `system.read`) is refused before render | fails today: `AdminRoute` admits them |
| R2 | `AdminRoute` **still admits that same principal** | control. Without it, a guard refusing everyone satisfies R1. Proves the new guard genuinely differs |
| R3 | `super_admin` reaches the page | positive control |
| R4 | route table pairs the route with the new guard | §2. Behavioural tests prove what the guard *does*, never that *this route uses it* |
| R5 | server: `system.read ∈ ORG_CAPABILITIES` | #121's guard, re-asserted from this issue's side |

Fixture requirements, each from a defect already paid for:

- **`multiUserMode: true` in every fixture.** Both guards bypass on `|| !multiUserMode`, so a
  fixture missing it is green under any guard — #94 / #49 class.
- **`resetCapabilities()` per test.** The map is cached in a module-level promise; without it
  every case after the first runs on the first one's capabilities (found in #127).
- **No `getByRole(name)` for any name assertion.** The accessible name falls back to text
  content — #124 QA-3 deleted an `aria-label` entirely with 4/4 still green.

---

## 5. Scope and residual

This closes the mismatch **for this page only**. The other route sites keep whatever
approximation they have — 26 `AdminRoute`, 10 `ManagerRoute`, 3 `SingleUserRoute`, counted with
line comments stripped. #132 does **not** convert them and does **not** add `system.read` to
`ORG_CAPABILITIES` (TL-2 condition 2; #121 owns that).

## 6. Tier

**plain** while the diff is frontend-only. Reclassify to **auth** immediately if any server file
is touched.
