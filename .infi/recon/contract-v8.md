# V8 contract — one viewport authority for mobile layout

Base `origin/approof/main`. Every number below was measured on that base with tests excluded,
comments stripped, and the removed set printed before the count was reported (§7.17 do-not-repeat,
2026-09-02). No code until #132 closes.

---

## The defect

Layout is decided by two authorities that do not agree and neither knows about the other.

- **CSS**: Tailwind `md:` — 130 uses. `tailwind.config.js` has **no `screens` override**, so `md`
  is the default **768px viewport width**.
- **JS**: `isMobile` from `react-device-detect` — a **user-agent** test, not a viewport test.

| situation | CSS says | JS says |
|---|---|---|
| desktop browser narrowed to 500px | mobile | **desktop** |
| phone/tablet in landscape at 900px | desktop | **mobile** |

Both rows are wrong in production today. `SidebarMobileHeader` failing to cover is a symptom of
the disagreement, not a missing breakpoint.

**Ruling (TL-2, 36c556d02 + 065afc05b): viewport is the single authority.** No `isMobile` site in
this codebase is actually asking "is this a touch device"; every one is asking about width.

---

## Slices

Three, in this order. Each is a separate PR.

### (ก) Three surfaces → subscribing viewport hook

`components/SettingsSidebar/index.jsx:64` · `components/WorkspaceChat/ChatContainer/index.jsx:489,550`

A new `useIsMobileViewport()` hook, subscribing — `useState` + `useEffect` +
`matchMedia().addEventListener("change")` + cleanup.

**`hooks/usePrefersDarkMode.js` is a do-not-copy, and the reason is not style.** It has no
`useState`, no `useEffect` and no subscription — it is a plain function that re-reads
`matchMedia` whenever its caller happens to re-render for some other reason. It cannot respond to
a change on its own. Copying that shape for viewport produces a component that is correct on
mount and silently wrong for the rest of the session, which is exactly the moment a user resizes
and expects a response.

**Copy `hooks/useTheme.js:34-47` instead** — same repo, same `matchMedia` question, and it
already does the subscribe/cleanup correctly. `PWAContext.jsx:36-55` is a second correct
reference with the `addListener` fallback.

`SettingsSidebar/index.jsx:64` is a hard `if (isMobile) return <entirely different tree>` in a
548-line file. It is the largest single item and it goes **last within (ก)** — #126 slice 2
(Dev2) also targets that file, so the lane must be clear first.

### (ข) The copied height idiom → one Tailwind class

**53 lines / 41 files**, one PR, mechanical.

- **52** are byte-identical: `style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}`.
  Zero variants — verified by diffing every match against the exact string.
- **+1** `components/WorkspaceChat/LoadingChat/index.jsx:11` —
  `style={{ height: "calc(100% - 32px)" }}`, the same idiom with the mobile branch **already
  lost**. It is the loading state of the container (ข) converts
  (`WorkspaceChat/index.jsx:82,113`), so excluding it means the chat is 32px short on mobile
  while loading and correct once loaded. A `grep 'isMobile ? …'` cannot see this line, which is
  the same filter blindness that produced the original count of 10.

Replacement: delete the `style` prop, add `md:h-[calc(100%-32px)]` to the className.

**Where the 32px comes from — TL-1 pre-read 996bdbb26, and it must be written down.** The number
is not arbitrary and is not a magic constant: every one of the 53 sites also carries
`md:my-[16px]` in the same className — verified, 53 of 53, LoadingChat included. 16px top plus
16px bottom is the 32px the height subtracts. The two are one decision expressed twice, and today
the halves are in different languages: the margin in a Tailwind class, the compensation in an
inline style keyed off the user agent.

That is why the conversion is safe and also why it is fragile if left unexplained. After (ข) both
halves are classes on the same element and change together under the same breakpoint. **One site
carries a comment naming the relationship** (`ChatContainer/index.jsx`, the most-read of the 53),
so the next person to change `md:my-[16px]` finds out that a height depends on it. The contract
records it here so the comment is not the only copy.

Three facts that make this safe as one mechanical PR, each measured:
- All 53 sites **already carry `h-full`** in the adjacent className. The mobile half of the
  behaviour is already expressed in CSS; only the desktop half needs adding.
- **Zero** sites carry any existing `md:h-*`. No specificity conflict to resolve.
- Arbitrary-value syntax is established repo convention — 16 existing sites use
  `[calc(100%-40px)]`, `[calc(100%-76px)]`, `[calc(100vh-90px)]`.

**35 of the 41 files lose their `react-device-detect` import entirely.** Six keep it and must be
named in the lint rule, or "no new imports" will read as "these six are new":
`components/WorkspaceChat/ChatContainer/index.jsx` (cleared by (ก), not (ข)) ·
`components/WorkspaceChat/LoadingChat/index.jsx` · `pages/Main/Home/index.jsx` ·
`pages/Admin/Agents/index.jsx` · `pages/GeneralSettings/ChatEmbedWidgets/index.jsx` ·
`pages/WorkspaceSettings/index.jsx`.

### (ค) Residual — 24 lines / 15 files, accepted with an enumerated allowlist

Enumerated in `.infi/recon/v8-allowlist-24.txt`, **not a count** — a count cannot tell a reviewer
whether a new site was added or an old one moved.

TL-2's ~19 is superseded. Shape breakdown of the 27 pre-(ก) residual: 11 `if (isMobile`,
7 `&&`/`!isMobile &&`, 7 ternary, and **2 inline `|| isMobile` guards**
(`RenderMetrics/index.jsx:106`, `WorkspaceModelPicker/index.jsx:122`) — the two a shape-based
filter drops, the same class as the ternary drop and the LoadingChat drop. Three filters, three
misses, one cause.

`components/Modals/ManageWorkspace/index.jsx:47` uses **`isMobileOnly`**, the only site in the
codebase to do so. Phone-excluding-tablet is a genuinely narrower question than the other 23;
it stays in the residual with that note rather than being converted by analogy.

---

## Accessibility DoD — red tests, not a checklist line

Carried from #124: an accessible name must describe purpose and be **constant**.

- `SettingsSidebar/index.jsx` has **zero** `aria-label` and **zero** `aria-expanded` in 548
  lines, and its mobile menu button (~line 68) is icon-only (`<List />`). A screen-reader user
  hears "button" on the one control a mobile user must press first.
- `Sidebar/index.jsx` has 2 (`aria-label="Home"` :49, `aria-label="Show sidebar"` :118) and **no
  `aria-expanded`** on a control that toggles a panel.

**Assert `getAttribute("aria-label")` directly, never `getByRole(name)`.** #124 QA-3: deleting the
label entirely left 4/4 green because the accessible name falls back to text content. Assert the
mechanism, not the query result, and require a non-empty string.

---

## Evidence contract

RED before GREEN on every item; each mutation named below must be **run** and observed failing,
not reasoned about.

| # | assertion | the mutation that must turn it red |
|---|---|---|
| F1 | hook re-renders on viewport change | dispatch a `matchMedia` change event with no resize; a non-subscribing hook (the `usePrefersDarkMode` shape) stays stale |
| F2 | hook cleans up | unmount, fire change, assert no setState-after-unmount warning |
| F3 | breakpoint is 768px | drift test reads `tailwind.config.js`, asserts no `screens` override, and pins 768 — a config override silently moving `md` must go red |
| F4 | all 53 (ข) sites converted | count `isMobile ? "100%" : "calc(100% - 32px)"` == 0 AND `height: "calc(100% - 32px)"` == 0; **and assert the scanned file count equals the expected number**, not merely that it is non-empty (TL-1). A glob that silently narrows to one file reports "zero remaining" and passes; a count pins what was actually searched |
| F5 | residual is exactly the allowlist | compare the measured set against `v8-allowlist-24.txt` **as a set, both directions**; the failure message **prints both directions separately** — sites present-but-not-listed and listed-but-absent are different defects (a new UA dependency vs. a stale allowlist) and a single "sets differ" message sends the reader to the wrong one |
| F6 | lint blocks new `react-device-detect` imports | add a probe import in a non-allowlisted file, confirm red; delete the probe |
| F7 | a11y names present and constant | `getAttribute("aria-label")` non-empty on the SettingsSidebar menu button and the Sidebar toggle; `aria-expanded` flips with panel state |
| F8 | the six surviving imports are the six named | list them from source and compare as a set — not `toContain` |
| RF-9 | the hook follows WIDTH, not the user agent — the two conflicting rows | see below |

### RF-9 — the only two fixtures that can tell the implementations apart (TL-1)

Every *consistent* fixture (narrow + mobile UA, wide + desktop UA) passes under **both** the old
`isMobile` implementation and the new viewport hook, because the two agree there. A suite built
only from consistent fixtures is green before the change and green after it — describing the
behaviour rather than asserting it, the exact class in `tests-that-pass-vacuously`.

Only the two rows where the axes conflict separate them:

| fixture | expected after V8 | what the old code does |
|---|---|---|
| width 500 + **desktop** UA | mobile tree | desktop tree |
| width 900 + **mobile** UA | desktop tree | mobile tree |

**Named mutant: keep `isMobile`.** Revert the hook to the user-agent read and these two must go
red while every consistent fixture stays green. Run it — if the suite survives, the fixtures are
all consistent and RF-9 is not present regardless of what the test file is called.

**Vacuous-pass guard, from `tests-that-pass-vacuously`:** every extraction offset is asserted
before slicing (#127 QA-3: `indexOf` → -1 → `slice(0,-1)` ≈ whole file, assertion fails open),
and no assertion may run inside a loading window where nothing could yet have differed (#124).

## Mockup — required before any code

Step 1.5. Static images cannot show what is wrong here, because the defect **is** the transition.
The mockup must demonstrate:
1. a resize from wide to narrow on one page, live;
2. the **tablet-landscape 900px** case, where CSS and JS currently disagree — the one row that
   proves the change is behavioural and not cosmetic;
3. `SettingsSidebar`'s two trees side by side.

`docs/superpowers/mockups/`, HTML + Tailwind, one file, committed, SHA pinned in the issue.

## Sequencing

`#132` (mine) → V8. Within V8: (ข) first (mechanical, no lane risk), then (ก) with
`SettingsSidebar` last, after #126 slice 2 clears that file. (ค) is documentation + lint, no
source edits.

## Tier

**plain** — frontend only, no auth/permission/schema/secret path. Reclassify to `auth`
immediately if any slice touches a server file.
