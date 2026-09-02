# Techlead-1 — #132 pre-read of Dev4's RED tests (uncommitted, `/tmp/wt-132red` at `5c9ea893d`)

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization bypass at the client guard, privilege boundary naming. `infi-lessons` not
invoked; no §7.17 line here.

§7.14: no suite run. Read the three files and the sources they assert against, in a read-only
worktree.

---

## Against TL-2's conditions (`ddf0772f2`): all four met, and (ข) is met at the level of the fixtures, not just the test names

**Capability, never role** — the maps are literals keyed by action
(`HOLDS_SETTINGS_WRITE_NOT_SYSTEM_READ`), the `fetchMyCapabilities` mock returns the map
directly, and the header states why: a regrant such as #137 changes who holds `system.read` and
must not turn a correct guard test red. Role names survive only as comments on the constant
names. This is the condition most likely to be satisfied superficially — a test named "a
principal without system.read" that builds its fixture from a role — and it is not.

**R6 both halves with an identifiable mock** — `UserMenu` is mocked as
`<div data-testid="user-menu">`, not a passthrough, so "absent" is distinguishable from
"rendered transparently". Both directions asserted. The note that this route does **not** pass
`hideUserMenu` in production, and that R6 therefore tests the prop's wiring rather than a live
path, is the right disclosure — a prop no route exercises is exactly the one a refactor drops.

**R4 spans exactly one route and strips trailing comments** — brace-matched from the path
literal, every failure returns a `{error}` rather than a degraded slice, and
`(code.match(/path: "/g)).length === 1` pins the span. Trailing `//` stripping is there because
the mutation "guard name planted in a trailing comment beside de-guarded code" was **run** and
passed the naive strip. The P-bleed table records that `prettier reflow` is GREEN here where the
shipped #127 version dies — that is the improvement over QA-3's offset guards, which converted
fail-open to fail-noisy but stayed brittle.

**R5 non-vacuity** — three layers: the `toContain`, a shape assertion (`Array.isArray`,
`length > 5`) against a future refactor making the export an object, and the derived check that
reads `requirePermission("...")` out of `endpoints/mobile/index.js` rather than restating the
action — with `enforced.length > 0` guarding the derivation itself. That last test is the §7.9f
answer done properly: the expectation comes from the routes, the subject is the capability list,
and they are different files.

**One gap, and it is TL-2's own added test.** Condition-list item 2 of `ddf0772f2` asks for a
control that **`AdminRoute` still admits the principal** — R2 has it. But TL-2 also asked for a
control that the guards differ *by capability rather than by rename*; R2 covers exactly that and
I confirm it is present. Nothing missing.

## FINDING — R5's precondition is a precondition of the *frontend* suite, and nothing enforces the order

`system.read` is in `ORG_CAPABILITIES` at this SHA (`endpoints/system.js:132`, #121 landed), and
`ORG_CAPABILITIES` is exported (`:2326`), so R5 runs. But R5 lives in the **server** suite and the
guard lives in the **frontend** suite: a revert of #121, or a rename of that key, turns R5 red
while every frontend test stays green, because they mock the map. That is stated in R5's header
and is correct — but it means the two suites must both run for the pair to mean anything, and
nothing in the issue says so. **Write that into the evidence contract**: #132's gate is
`frontend` **and** `server/__tests__/security/systemReadCapabilityExposed.test.js`, not either
alone. This is the same shape as the vocabulary-pin lesson from #137 — one dependent named is not
the set.

## The `998f4438a` question: **#132 must NOT be the first instance of the prop pattern**

TL-2's sidebar ruling says `AdminRoute`/`ManagerRoute` keep their names and **take the action as
a prop** for the rows the audit flags. That is a different change from `SystemReadRoute`, and the
two do not conflict — but they must not be merged into one issue, for the reason TL-2's own #132
ruling gives:

- `SystemReadRoute` is a **named guard whose name states what it asks**. `<AdminRoute action="system.read">` is a guard whose name still says "admin" while asking something else — the lie that is the root of #127 and #132, now parameterised.
- The prop pattern's value is that the *audit* decides an action per row with evidence behind each one. #132 has that evidence for exactly one route. Shipping the prop here means the first call site is chosen by which issue happened to land first, not by the audit — and the pattern's whole justification is that the call sites were scoped.
- **Direction matters and TL-2 named it:** collapsing three correct specific guards into one generic later is a mechanical refactor; splitting a half-converted generic back out is not. #132 shipping `SystemReadRoute` leaves the audit issue free to convert it along with the rest, or to keep it.

So: **`SystemReadRoute` as designed, and the audit issue converts it if the prop pattern wins.**
Worth one line in #132's residual saying that this guard is a candidate for the audit's
conversion, so the next person does not read it as a competing pattern.

## Verdict on the pre-read

The three files are ready to go RED. No changes required. Two things to fold in: the two-suite
gate in the evidence contract, and the residual line pointing `SystemReadRoute` at the audit
issue.
