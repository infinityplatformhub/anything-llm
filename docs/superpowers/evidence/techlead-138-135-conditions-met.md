# Techlead-1 — #138 RF-R `f1662b808` and #135 RF-K `a864a6121`: both conditions met

**Skills invoked:** `superpowers:requesting-code-review`; `security-review` checklist —
authorization action correctness, credential revocation. `infi-lessons` for the ledger correction.

§7.14: no suite run. Source reads and `node -e` in detached worktrees (`/tmp/tl-rfr`,
`/tmp/tl-rfk`, `/tmp/tl-q`), Node 22 via `/opt/homebrew/opt/node@22/bin`.

---

## #138 RF-R — **met, and it varies exactly one thing**

Same user, same session, same route; the only change between the 403 and the 202 is a single
`role_permissions` row for `directory.sync`. That is the discriminator, and it is the shape I
asked for rather than a restatement of it: if the gate asked any of the other 53 actions, the row
would change nothing and the test would stay red. The comment records the §7.17 line and names its
three instances.

**Dev3's no-bump claim is correct and I verified the mechanism rather than accepting it.**
`engine.js:128-130`: *"The memo lives for this call only: a longer-lived cache would let a removed
membership keep authorizing"* — the memo is constructed per `authorizeMany` invocation, and
`requirePermission` holds no `FilterCache` (that cache serves document filters, not action
decisions). So the second request reads the row just written. Worth noting that the test says it
**checked** this rather than assumed it, which is the right disposition for a claim that would
otherwise make the test red for an unrelated reason.

Gate measurement `MR` (gate → `user.manage`) reddening **both** RF-R and the setup_admin refusal is
the expected signature: under that mutation setup_admin holds the gated action from the start, so
the 403 that opens RF-R fails too.

**No objection. #138 queue half is a clean PASS.**

## #135 RF-K — **met, and MK3 landing on the control is the point**

Per route: `keys.length > 0` before the loop (so the loop cannot pass over an empty set), every
victim key non-null, **and** the bystander key still null. Dev2's note that **MK3 was caught by the
control key, not the loop**, is the evidence that the pair is doing separate work — a route
stamping every key passes the loop and fails only the control. `endowed()` creating the victim's
keys is what makes the non-empty guard meaningful rather than incidental.

**No objection. #135 is a clean PASS.**

## Ledger correction for #138 — TL-2 is right, and the difference matters

Dev3's ledger says mutant **M7C** reds RF-7b alone. TL-2 measured it redding **both** RF-7 and
RF-7b — RF-7 via its setup (`pausedAfter` never reaching 2, so the assertion at the head of the
test fails before the refusal is ever exercised).

Correct the ledger, and not as a bookkeeping fix: a mutant recorded as killing one test when it
kills two overstates that test's discriminating power. The next person deciding whether RF-7b is
load-bearing reads "M7C reds RF-7b alone" as proof it is the only thing standing between the guard
and a regression — when in fact RF-7's own setup catches that mutant first, and RF-7b's real job is
the *other* direction (a guard that refuses everyone). The correction makes RF-7b's justification
weaker on paper and more accurate, which is the direction a ledger should err.

**§7.17 line, if PMO wants one:** *"A mutant's kill list is part of the record. Attributing a kill
to the wrong test overstates that test's power and misleads whoever later asks whether it can be
removed."*
