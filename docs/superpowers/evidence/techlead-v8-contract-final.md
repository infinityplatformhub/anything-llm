# Techlead-1 — V8 contract final read (`d31053089` / `b493873ac`) against QA-1's RF-9 skeleton

**Skills invoked:** `superpowers:requesting-code-review`. `security-review` not applicable —
plain tier, frontend only, no server file in any slice. `infi-lessons` not invoked.

§7.14: no suite run. Read the contract, `qa1-v8-harness.md`, and `frontend/package.json`.

---

## Ready for code the moment the mockup is approved — with **one assertion to fix before F2 is written**

Everything I asked for in `996bdbb26` is folded in, and two of the three landed stronger:

- **The `md:my-[16px]` relationship** is written into (ข)'s justification *and* required as a comment at one representative site, with the contract stating why the comment is not the only copy. My pre-read measured this on the 40 ternary files; the contract re-measured it as **53 of 53 including LoadingChat**, which is the superset and the right number.
- **F4 pins the scanned file count**, not merely non-empty — and QA-1's harness asserts `scannedFileCount == 602` alongside the zero counts, so a narrowed glob reports red rather than "zero remaining".
- **F5 prints both directions separately**, with the reason (a new UA dependency and a stale allowlist are different defects that send the reader to different places).
- **RF-9 is present with its named mutant**, and QA-1's skeleton measured the baseline: 3 pass / 4 fail on main, with the keep-`isMobile` mutant reproducing exactly that red set. That is the difference between RF-9 existing and RF-9 being asserted.

**The LoadingChat behaviour-change note is the most valuable line in the contract.** It is the one
of the 53 whose conversion *changes* behaviour rather than preserving it — the mobile branch is
already lost, so the chat is 32px short while loading — and both the contract and QA-1 name it as
a fix rather than a refactor. A reviewer who did not know that would read a behavioural diff as a
mechanical one.

## The one problem: **F2 as written cannot fail on React 18**

```
F2 | hook cleans up | unmount, fire change, assert no setState-after-unmount warning
```

Measured: `frontend/package.json:40` is `react ^18.2.0`, installed `18.3.1`. **React 18 removed
the setState-after-unmount warning** (it was deleted in 18.0 as a false-positive source). So the
assertion is "no warning was logged" against a version that never logs it — green with the
cleanup, green without it, green against a hook with no `useEffect` at all. That is a
§7.9f fixture: it derives its expectation from something that cannot vary.

It matters here more than usual because cleanup is the *only* difference between the correct hook
and a plausible wrong one that adds a listener and never removes it — and that bug is invisible in
a single-mount test.

Replace it with an assertion on the mechanism:

```
F2 : the SAME MediaQueryList instance receives addEventListener and, after unmount,
     removeEventListener with the SAME handler reference — asserted on a spied
     matchMedia return object, and paired with a mounted control proving the
     listener was registered at all
mut  : delete the cleanup return from useEffect
why  : the warning-based version is green under that mutation on React 18 because
      the warning does not exist. Only the removeEventListener call distinguishes
      them, and the handler identity is what catches a cleanup that removes a
      different function than it added.
```

QA-1's harness already builds a `matchMedia` mock that parses the query with a mutable width, so
the spy surface exists; this is a change to what F2 asserts, not new machinery.

## Two smaller things, neither blocking

**F1b (no listener registered) needs its stated guard carried into the contract.** QA-1 found it
was *"satisfied by 0→0"* — a count that starts and ends at zero passes whether or not the hook
subscribes. The contract's F1 row does not mention it. One line, since the harness already fixed
it and the contract is what survives.

**F3 pins 768 from `tailwind.config.js`.** Correct, and worth one clause: it must assert the
absence of a `screens` override *and* that `md` resolves to 768 — asserting only the absence
passes if a future Tailwind major changes the default.

## Verdict

**Ready.** Fix F2 before it is written — not after, because a green F2 is indistinguishable from a
correct one and nobody re-opens a passing test. Everything else can go to code the moment the user
approves the mockup.
