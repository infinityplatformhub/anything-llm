# V8 recon — mobile responsive

Read-only. Base `origin/approof/main`. **No code.** Month 2, not started.

---

## The finding that shapes the whole issue

**Layout is decided by two different things that do not agree, and neither knows about the
other.**

- **CSS** uses Tailwind breakpoints — `md:` appears **130 times** across `src/components/`
  (`xl:` once, `sm:`/`lg:` never). `tailwind.config.js` has **no `screens` override**, so `md`
  is the default **768px viewport width**.
- **JavaScript** uses `isMobile` from `react-device-detect` — **131 occurrences across 52
  files**. That is a **user-agent** test, not a viewport test. It is true on a phone held in
  landscape at 900px, and false on a 500px-wide desktop browser window.

So today:

| situation | CSS thinks | JS thinks |
|---|---|---|
| desktop browser narrowed to 500px | mobile (`md:` off) | **desktop** |
| tablet/phone in landscape at 900px | desktop (`md:` on) | **mobile** |

`ChatContainer/index.jsx:489,550` renders `{isMobile && <SidebarMobileHeader />}` while the
surrounding layout switches on `md:`. In both rows above the two disagree, which is precisely
where "SidebarMobileHeader does not cover" comes from — it is not a missing breakpoint, it is
**two layout authorities with different definitions of mobile**.

**This is V8's central decision, and it is not a styling choice:** either the JS branches move to
a viewport-based hook (matching CSS), or the CSS moves to a UA-based class (matching JS). The
first is almost certainly right — a narrow desktop window is a narrow window — but it changes
behaviour on real devices and needs a ruling, not a preference.

## Current state, measured

**`Sidebar/index.jsx`** — no `isMobile`; exports `SidebarMobileHeader` (line 84) which callers
render conditionally. So the component is mobile-aware but the *decision* to show it lives in its
callers, three of them, each repeating the same `isMobile &&` test.

**`SettingsSidebar/index.jsx`** — a single hard `if (isMobile)` at line 64 returning an entirely
different tree. Not a responsive layout: two layouts chosen by user agent. A desktop window at
400px gets the desktop tree, unusable.

**`ChatContainer/index.jsx`** — 6 `md:` classes plus two `isMobile &&` header renders, and
`style={{height: isMobile ? "100%" : "calc(100% - 32px)"}}` — an inline style deciding height by
user agent while the classes beside it decide by viewport.

## Accessibility baseline (from #124)

#124 established that a control's accessible name must describe its purpose and be constant.
Measured against the mobile surfaces:

- `SettingsSidebar/index.jsx` — **0** `aria-label` / `aria-expanded` across the file, and its
  mobile menu button (line ~68) is **icon-only** (`<List />`). It has no accessible name at all:
  a screen-reader user hears "button". Same defect class as #124, on the one control a mobile
  user must press first.
- `Sidebar/index.jsx` — 2 attributes total (`aria-label="Home"` line 49, `aria-label="Show
  sidebar"` line 118). Better, but **no `aria-expanded`** on a control that toggles a panel, so
  the state is invisible to assistive tech.

**V8 must not ship new mobile affordances without names and expanded-state**, or it multiplies
the #124 defect across the surface a mobile user depends on most. Recommend this as an explicit
DoD line rather than an assumption.

## Collisions

- **#121** (open, in flight) — touches `frontend/src/main.jsx` and settings pages for the
  remaining role-string sites. V8 touches `SettingsSidebar/index.jsx`, which #121 also converts
  (its `roles: ["admin"]` entries). **Sequence V8 after #121**, or the sidebar's role blocks
  conflict.
- **#126** (Dev2, gate extraction) — explicitly targets `SettingsSidebar` and `Home`, extracting
  their gates into render-testable components. That is the *same file* V8 restructures for
  layout. **Hard collision.** Either #126 lands first and V8 restructures what it leaves, or V8
  waits. Doing both concurrently means two people rewriting one component for different reasons.
- **#132** (mine, blocked on #121) — `PrivateRoute/index.jsx` and one `main.jsx` route. No
  overlap with V8's files.

## Mockup — required, and not optional here

Step 1.5 applies: V8 is a UI change with visible layout decisions. It needs a clickable mockup
approved before code, and V8's mockup has to show something a static image cannot — the
**transition** across the breakpoint, since the whole issue is that the transition is currently
inconsistent. Recommend the mockup demonstrate: a resize from wide to narrow on the same page, a
tablet-landscape case (where CSS and JS currently disagree), and the settings sidebar's two
layouts side by side.

## Size

Not small. 52 files reference `isMobile`; V8 does not have to convert all of them, but it has to
decide the rule and apply it to at least the three surfaces above, then leave the rest
consistent or explicitly deferred. The accessibility baseline adds work that is cheap per control
and easy to skip.

## Open questions for a ruling

1. **Viewport or user agent?** (§ above.) Recommend viewport, with `isMobile` retained only where
   the question genuinely is "is this a touch device".
2. **Scope**: three surfaces, or all 52 files? Recommend three, with the rest recorded as a
   residual rather than silently left inconsistent.
3. **Sequencing against #126** — the `SettingsSidebar` collision is real and needs an owner
   ordering, not a merge conflict.
