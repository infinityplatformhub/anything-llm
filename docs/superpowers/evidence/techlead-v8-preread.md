# Techlead-1 — pre-read: V8 (plain tier), on contract `46a10d846` / allowlist `31ac174af`

**Skills invoked:** `superpowers:requesting-code-review` (design read of the contract against
measured source). `security-review` not applicable — plain tier, frontend only, no server file in
any slice. `infi-lessons` not invoked; no §7.17 line added here.

Everything below was measured on `origin/approof/main`, in `frontend/src`.

---

## (ข) The mechanical slice — safe, and the contract understates *why*

**Confirmed as claimed:**

- 52 byte-identical occurrences of `height: isMobile ? "100%" : "calc(100% - 32px)"`, across **40 files** (the contract says 41 including `LoadingChat`, which carries the mobile-lost variant and no `isMobile` in that line — consistent).
- **All 40 files carry `h-full`** in the className adjacent to the converted `style` prop. Verified per file rather than in aggregate, since the aggregate claim is what a spot-check would confirm falsely.

**FINDING — the justification is stronger than "all sites carry h-full", and the contract should
say the stronger thing.**

Measured: **all 40 files carry `md:my-[16px]` in the same className block.** So
`calc(100% - 32px)` is not an arbitrary offset — it is exactly the 16px top plus 16px bottom
margin that the same element applies at the `md:` breakpoint. The height rule and the margin rule
are the same decision written twice, in two languages, one of which was consulting the user agent.

That matters for the contract in a way that "already carries `h-full`" does not: it tells the
reviewer **why the breakpoint on the new class must be `md:` specifically** — because it must fire
exactly when `md:my-[16px]` fires. If a future change alters that margin, the height must move
with it, and a reader who only knows "we replaced an inline style" has no way to know that. Write
the margin relationship into the contract and, better, into a comment at one representative site.

This also resolves (ข)'s risk more completely than the parent-height question does: the value is
self-referential to the element's own margin, not to its parent's box.

## The five sites whose parent is not `h-screen`

Asked for, and here they are. 35 of 40 have an ancestor within 8 lines carrying `h-screen`; these
five do not:

| site | why it is still safe |
|---|---|
| `components/DefaultChat/index.jsx:110` | The element is a `Layout` wrapper whose own className is `w-full h-full`; its parent is supplied by the route, which is the same `h-screen` shell as the others. |
| `components/WorkspaceChat/ChatContainer/index.jsx:480` | Same file already in the (ก) list; its container is `WorkspaceChat/index.jsx`. |
| `pages/Admin/ExperimentalFeatures/index.jsx:46` | `w-full h-full flex justify-center items-center` — no scroll, centred content; a height that resolved to `auto` would collapse visibly in the mockup. |
| `pages/Admin/Agents/index.jsx:341` | In the six-file keep list; `isMobile` survives here for other reasons. |
| `pages/Main/Home/index.jsx:143` | `w-full h-full overflow-hidden`, in the keep list. |

**None of them changes the analysis, and here is the reason that covers all five:** the conversion
does not change what the height resolves to. `h-full` + `md:h-[calc(100%-32px)]` computes against
the same containing block the inline `height` did — the percentage base is identical, because it
is the same element and the same parent. If a parent is not height-constrained, `calc(100% - 32px)`
was already resolving against an `auto` base *before* this change, and the inline style had the
same problem. **(ข) cannot introduce a defect here; it can only preserve one.**

That is worth stating explicitly in the contract rather than leaving as "we checked the parents",
because the parent question invites a reviewer to look for a difference that cannot exist. What
*would* differ is specificity and breakpoint timing, and both are addressed: zero sites carry an
existing `md:h-*` (confirmed), and the breakpoint is pinned by F3.

## The six-file keep list is correct — measured a different way

The contract names six files that keep `react-device-detect` after (ข). I derived the set
independently: for each of the 40 idiom files, count `isMobile|isMobileOnly|isTablet|isDesktop`
excluding the import line, subtract the idiom occurrences, keep those with a remainder.

```
components/WorkspaceChat/ChatContainer/index.jsx   remaining 2
pages/Admin/Agents/index.jsx                       remaining 6
pages/GeneralSettings/ChatEmbedWidgets/index.jsx   remaining 2
pages/WorkspaceSettings/index.jsx                  remaining 1
pages/Main/Home/index.jsx                          remaining 1
```

Five, plus `components/WorkspaceChat/LoadingChat/index.jsx` — which is not in the 40 because its
occurrence is the mobile-lost variant, and which has 3 other uses. **Six, and the same six.**
Independent derivation, same answer.

## F4 — the non-empty glob guard is right, and needs one more clause

Asserting the file list is non-empty before counting closes the "broken glob reads as zero
remaining" hole. One addition: assert the list length **equals the expected file count** (or is
within a stated range), not merely `> 0`. A glob that matches one file is non-empty and still
reports zero remaining for the other 39.

Same shape as the vacuous-pass guard the contract already carries from #127.

## F5 — set equality both directions is correct; name the diff on failure

`toContain` passing while a site is added is exactly the failure mode, and set-equality closes it.
Ask for the failure message to print **both** differences (present-but-not-allowlisted, and
allowlisted-but-gone). A bare `toEqual` on two sorted arrays of 24 paths produces a diff a reader
has to scan; naming which direction failed is the difference between "the allowlist is stale" and
"someone added an `isMobile`", which are opposite actions.

## `useTheme.js:34-47` as the reference — confirmed, and the do-not-copy warning is the load-bearing half

The contract's argument against `usePrefersDarkMode` is right and is the most valuable paragraph
in it: a hook with no `useState`/`useEffect` re-reads `matchMedia` only when its caller happens to
re-render, so it is correct on mount and silently wrong for the rest of the session. That is a
defect that no static review of the copied code would catch, because the copy looks like the
original.

F1's mutation (dispatch a `matchMedia` change with no resize) is the right discriminator: a
non-subscribing hook stays stale under exactly that stimulus and passes every other test.

## One gap in the evidence contract

F1–F8 cover the hook, the conversion, the lint rule and a11y. Nothing covers **(ก)'s behavioural
claim**: that replacing the user-agent test with a viewport test changes what renders in the two
disagreement rows. The mockup demonstrates it to a human; no test pins it.

```
RF-9 : render SettingsSidebar at width 500 with a DESKTOP user agent, assert the
       mobile tree; and at width 900 with a MOBILE user agent, assert the desktop tree
mut  : keep `isMobile` (today's behaviour)
why  : every fixture that sets width and user agent CONSISTENTLY is green under both
       implementations — that is the whole point of the defect. Only the two
       disagreement rows separate them, and they are the two rows the contract's own
       table names as wrong in production today.
```

Without this, (ก) can ship a correct hook that no test proves is actually consulted, and the
mockup's tablet-landscape row — the one the contract calls out as proving the change is
behavioural rather than cosmetic — has no counterpart in the suite.

## Verdict on the pre-read

The contract is sound and the measurements in it hold. Three things to fold in: the
`md:my-[16px]` relationship as (ข)'s justification, F4's count-equality clause, and RF-9.
