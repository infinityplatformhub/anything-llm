# #126 slice 2 — pre-read against the #121 final SHA

Skills: `infi-dev` (evidence contract), `test-driven-development` (fixture shape
argued from what a mutant would survive).

Docs only, no code. Read in a detached worktree at **`5c9ea893d`** (`#121 TL-1:
make \`hidden\` work on a parent that has children`), not against main — #121 is
not merged, so main does not yet contain what slice 2 must build on.

---

## 1. Line overlap: none

**The measurement, not the conclusion.** `#121`'s substantive commit is
`7960ceac1` (7 files, +609/-69). Its hunks in `SettingsSidebar/index.jsx`:

```
@@ -236,58 +236,58 @@ const SidebarOptions = ...
@@ -299,30 +299,30 @@   @@ -338,7 +338,7 @@    @@ -355,19 +355,19 @@
@@ -380,19 +380,19 @@   @@ -419,13 +419,13 @@   @@ -437,25 +437,25 @@
@@ -465,7 +465,12 @@    @@ -475,7 +480,7 @@
```

Every hunk starts at **line 236 or later**, and all nine sit inside
`SidebarOptions` — the menu-entry table where `roles:` became `capability:`.

Slice 2's territory:

| what | line at `5c9ea893d` |
|---|---|
| `hidePrivacyLink` computation | 46 |
| mobile call site | 131 |
| desktop call site | 180 |

**Lowest #121 line (236) is 56 lines below the highest slice-2 line (180).** The
lanes do not touch, and the follow-up `5c9ea893d` narrows this further: it
changes only `MenuOption/index.jsx` (+7/-2) and `capabilityGating.test.jsx`
(+52) — not `index.jsx` at all.

This is the two-people-one-file rule satisfied by measurement rather than by
assertion. Worth stating plainly: the rule has no exception for "different
lines", so what makes slice 2 safe is **not** the line gap — it is that #121
will be merged and closed before slice 2 starts. The gap only means the merge
itself will not conflict.

## 2. The privacy link is behind a capability already, and slice 2 does not change that

Answering the question as asked: it is **not** a role string. `#40 task 4`
(`42b392485`) already converted it, and `5c9ea893d` leaves it untouched:

```js
// SettingsSidebar/index.jsx:46
const hidePrivacyLink = !!user && (loading || !can("settings.write"));
```

with `hidden={hidePrivacyLink}` at 131 and 180.

So **slice 2 is not a conversion.** The decision is already right; what is
missing is that nothing renders it. That reframes the work, and the reframing is
the point of this pre-read:

> Slice 2 makes an existing correct decision *reachable by a test*, in the same
> way slice 1 did for the Home gate. It must not change the gate's answer for
> any input.

A slice 2 that alters behaviour has exceeded its scope and should be rejected.

## 3. What the current test actually covers — and the gap

`SettingsSidebar/capabilityGate.test.jsx` (103 lines, 4 tests) exists from #40
t4. Three of its four tests drive a **transcribed copy** of the gate declared
inside the test file:

```js
function PrivacyLinkGate() {           // ← lives in the TEST, not the component
  const { can, loading } = useCapabilities();
  const user = mockUser.current;
  const hidePrivacyLink = !!user && (loading || !can("settings.write"));
  return <a hidden={hidePrivacyLink}>settings.privacy</a>;
}
```

This is the exact shape slice 1 was rejected for and then fixed: a test that
proves the *logic* is right while nothing proves the *component* uses it. The
file knows this — its fourth test is a source assertion pinning the literal
string and `toHaveLength(2)` on the call sites, explicitly citing "the #115
failure mode".

**So the source assertion is not redundant with the render tests, and slice 2
must keep it.** They answer different questions — "is the decision right?" vs
"does anything call it?" — and deleting one because the other exists is the
mistake that cost slice 1 a QA-3 FAIL. Extracting a real `PrivacyLinkGate`
component converts three transcription tests into real ones; it does **not**
retire the drift check, which must be rewritten to pin the extracted call sites
rather than the inline expression.

**Gap found:** `capabilityGating.test.jsx` — #121's own 315-line, 17-test file —
contains **zero** references to `privacy`. The two files are one character apart
in name (`capabilityGate` vs `capabilityGating`) and cover disjoint surfaces.
Slice 2 should not add privacy tests to #121's file; the near-identical names are
a readability hazard worth flagging to the PMO separately.

## 4. Fixture shape: #121 RF-1 style applied to the privacy link

#121's RF-1 is the right model and its rationale is stated in its own comment:

```js
// "Asserted in a SINGLE render: three separate renders could each pass while
//  the entries were gated on one shared flag."
caps.map = { "user.read": true };
renderSidebar();
expect(screen.queryByText(LABEL.users)).toBeInTheDocument();
expect(screen.queryByText(LABEL.invites)).not.toBeInTheDocument();   // named neighbour
```

Applied to slice 2, the fixture must hold **`settings.write` alone** and assert
in one render:

1. the privacy link **is** present, and
2. a **named neighbour** gated on a different capability is **absent**.

The neighbour has to be picked deliberately, and this is where the fixture can
go quietly wrong. It must be an entry whose capability is genuinely different
from `settings.write` — if the chosen neighbour happens to be gated on
`settings.write` too, the assertion passes for free and the test proves the
capability string is *read* rather than that it is *the right one*. From #121's
own `LABEL` map, `settings.users` (`user.read`) and `settings.api-keys`
(`key.manage`) are both safe choices; the dev must verify against the entry table
at `index.jsx:236+` rather than assuming, since #121 rewrote exactly those lines.

The existing file already has the makings of the positive control:
`HOLDS_CREATE_ONLY` (`settings.write:false, workspace.create:true`) is the mirror
fixture. Keep both — a single-capability fixture in one direction only cannot
distinguish "reads the right capability" from "returns true whenever the map is
non-empty".

**Three properties, from the hook's own contract:**

- **`loading`** — `can()` answers false in flight, the same value as denied. The
  existing test file already hit this: TL-1 found that waiting on the fixture
  asserts against the loading state and passes even for an always-true `can()`.
  Its fix, the `CapabilityProbe` that flips text on settle, must survive the
  extraction.
- **denied** — `settings.write:false` hides it.
- **single-user (`!user`)** — visible with no capability at all. `!!user &&`
  is what does this, and it is easy to drop when moving the expression into a
  component whose props no longer include `user` by accident.

## 5. RF list for slice 2

- **RF-1** hold `settings.write` alone → link present **and** a named neighbour
  on a different capability absent, single render.
- **RF-2** mirror: hold that neighbour's capability alone → link absent. Kills a
  gate that answers true for any non-empty map.
- **RF-3** loading → hidden, then present once resolved. Asserted as a
  **transition**; asserting only the settled state cannot tell a gate that waits
  from one that never rendered.
- **RF-4** single-user (`user: null`) → visible with an empty map.
- **RF-5** the drift check, rewritten: both call sites (mobile and desktop) pass
  through the extracted component, and one value still feeds both. Strip
  comments before matching — a decoy comment defeats a whole-file match, measured
  in #40 t4.
- **RF-6** the gate's answer is **unchanged** for every input above versus
  `5c9ea893d`. This is the one that keeps slice 2 an extraction rather than a
  rewrite.

**Mutation that must go red before any SHA:** delete `visible`/invert the
capability and confirm RF-1 and RF-2 both fail; delete the `!!user &&` disjunct
and confirm RF-4 fails; point one call site at a literal `false` and confirm RF-5
fails. A mutation that reddens fewer tests than expected means the tests are
weak, not that the code has hidden defence — the lesson from #40 t2's M4b.

## 6. Lane

Slice 2 touches `SettingsSidebar/index.jsx` (lines 46, 131, 180) and its own new
component plus `capabilityGate.test.jsx`. It must not touch
`MenuOption/` or `capabilityGating.test.jsx` — both are #121's, and `5c9ea893d`
is the second commit to land in `MenuOption/index.jsx`.
