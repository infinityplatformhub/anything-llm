# Techlead-1 — pre-read: rescoped sidebar-audit contract (`a21e1be27`) against TL-2's `998f4438a`

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist — guard
conversion, capability exposure, access widening. `infi-lessons` not invoked.

§7.14: no suite run. Source reads and `node -e` in the main checkout (read-only).

---

## (1) Prerequisite slice: **sequenced and tiered correctly, but it is not yet its own gate**

The contract says the 12 capabilities are "a prerequisite slice, not part of the guard
conversion", and tiers that slice `auth` because it touches `endpoints/system.js`. Both right.

**What is missing is the enforcement.** There is no statement that the conversion slice may not
merge until the capability slice has, and no test that would fail if it did. The failure is exactly
#132's precondition: a guard asking a capability absent from `ORG_CAPABILITIES` gets `undefined`
from `can()` and **refuses everyone including `super_admin`** — a worse defect than the mismatch
being fixed, and invisible to a frontend suite that mocks the map.

```
RF-P : for EVERY action any converted guard names, that action is in ORG_CAPABILITIES —
       derived by reading the guard call sites, not by restating the list
mut  : convert one guard to an action not yet exposed
why  : every frontend guard test passes under that mutation, because the fixture
       supplies the map. This is #132's R5 generalised from one action to the set,
       and it is the assertion that makes "sequenced" true rather than intended.
```

Note the contract's own count needs re-deriving, not re-reading: it says "12 remain after #121's
four", but `system.read` is now in the list (`endpoints/system.js:132`) and #137 added
`model-router.read` — so the arithmetic moves under it. RF-P deriving from call sites rather than
a number is the fix for that too.

## (2) `|| !multiUserMode` and the loading hold: **named, honestly marked, and pinned by nothing**

The contract carries TL-2's two lines and — to its credit — states that the loading hold is
**inherited-untested**: deleting it leaves 15/15 green because `isAuthd === null` covers for it.
That is the right disclosure and the wrong stopping point. A prop-taking guard is a rewrite of the
component; "the tests were already blind to this line" is the condition under which a rewrite
silently drops it.

Both need an RF, and they need different ones:

```
RF-M : a single-user deployment (multiUserMode false) with an EMPTY capability map
       reaches the page through a converted guard
mut  : drop `|| !multiUserMode`
why  : every multi-user fixture is green without it. #40 t4's defect exactly.

RF-L : with capabilities still loading, the guard renders the loader and does NOT
       redirect — asserted with `isAuthd` already resolved true, so the null-check
       cannot cover for it
mut  : drop the capabilitiesLoading hold
why  : this is the one that is green today for the wrong reason. Forcing isAuthd
       true is what removes the cover; without that the test inherits the same
       blindness the contract admits to.
```

RF-L is the more valuable of the two precisely because the contract already measured that nothing
tests it.

## (3) Read/write derivation: **the embedder row is caveated, not corrected — and the caveat is in the wrong place**

The contract is admirably direct: *"my own table has the wrong split on that row, printed above
unaltered."* `/system/custom-models` is a POST gated `system.read`, so verb-derived classification
mis-assigns it and `settings.embedder`'s read column measures empty.

But a table printed with a known-wrong row, and a paragraph two sections below saying so, is a
document whose most-read part is wrong. **Correct the row and footnote the correction**, rather
than the reverse — the next reader copies the table, not the caveat. And the harness that produced
it should carry the fix, or the same row is wrong again on the next re-run: the contract itself
says re-run the four harnesses on the merged SHA, which will regenerate the same error.

This is the fifth extraction bug of this shape the audit has recorded (c1 counts four). At five, the
pattern is the finding: **method is not the authority, the action name is** — that belongs in the
contract's rule section (a), not only in a "does not resolve" section at the end.

## (4) telegram: **the six POSTs need `telegram.write`, and it exists — but it is granted to nobody but `super_admin`, which is the #63 shape to check before writing the plan**

Measured. `telegram.read` / `telegram.write` are in the seed vocabulary
(`seeds/permissions.js:85-86`) and reach `super_admin` only — every other seeded role holds
neither. They appear in `engine.js:35`'s list and in **no `requirePermission` call anywhere**.

So: use the existing actions (`telegram.write` on the six mutating POSTs, `telegram.read` on the
four GETs and on the sidebar entry). **Do not mint new ones** — this is the one row where the
vocabulary already has the right words and nobody wired them, which is precisely #63.

The thing to settle before the plan, and it is a real question the contract does not ask: today
these routes are reachable by any authenticated principal in single-user mode via
`isSingleUserMode`, and in multi-user mode by anyone at all who is authenticated. Adding
`requirePermission("telegram.write")` **narrows** access to `super_admin` only. That is correct as
security, and it is a behaviour change for existing multi-user deployments where an admin was
managing Telegram. Name it in the residual, and decide deliberately whether `setup_admin` gets
`telegram.*` — my answer is **no**, on the #137 reasoning (a bot that relays chats is not
"finish the installation"), but it should be a stated decision rather than a silent consequence of
which roles the seed happens to grant.

## (5) interface/chat ungating: **the measurement is sound and the RF pair is the right one — add the server half explicitly**

c2's measurement is the strongest part of this contract: every child component under
`Settings/components/` has **0 `API_BASE` references** and uses `localStorage`, and the only
server calls are the four every settings page makes. So "no server state" is measured, not
assumed, and removing the gate widens access to per-viewer display preferences only.

The RF the brief asks for is right, and the second half must be written as a *negative* over the
right surface:

```
RF-W1 : a principal holding NO org capabilities reaches /settings/interface and can
        change theme; the value persists in localStorage
mut   : keep the admin gate
RF-W2 : the ungating changes NOTHING server-side — no route's middleware array
        changes in this slice, asserted over the endpoints diff, and the four shared
        calls remain the only server calls the page makes
mut   : ungate a route as well as the entry
why   : RF-W1 alone is satisfied by a change that also removed a server gate, which
        is the one way this row could widen something real. The pair is what makes
        "display preferences only" an assertion rather than a claim.
```

## Overall

The contract is honest in the places that matter — it names its own harness bugs, marks the
loading hold as inherited-untested rather than covered, and refuses to inherit TL-2's
"widens no role" claim without re-running it. Those three are what a reviewer usually has to find.

**Three things to fold in before the plan:** RF-P (the prerequisite is a gate, derived from call
sites), RF-L (the untested line gets a test that removes its cover), and the embedder row
corrected in the table rather than below it. Plus the telegram narrowing named as a deliberate
decision.
