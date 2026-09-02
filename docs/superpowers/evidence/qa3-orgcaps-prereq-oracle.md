# QA-3 — ORG_CAPABILITIES prerequisite slice: RF-C verified

Measured on `/tmp/qa3-127` @ `5c9ea893d` with `qa3_121`'s real grants. The 10 actions from
`.infi/recon/recon-orgcaps-prereq.md` were added to `ORG_CAPABILITIES` locally (11 → 21),
the sidebar re-rendered, and the change reverted.

## 1. RF-C: **confirmed. No exception.**

Visible sets before and after are **byte-identical** for every role:

```
diff <(before) <(after)  →  no differences
```

**Metric: visible sidebar ENTRIES** — labels rendered and not `hidden`, from a fixed list of
27 (including `settings.privacy`). *Not* the count of actions a role holds, which is a
different measurement of the same fixtures: `super_admin` 11 held actions, `setup_admin` 4,
`content_moderator` 3, `member` 0 (Dev4's numbers, also correct). Quote the metric with the
number — 27 entries and 11 actions describe the same role.

| role | entries visible, before | after |
|---|---|---|
| `super_admin` | 27 | **27** |
| `setup_admin` | 25 | **25** |
| `content_moderator` | 1 | **1** |
| `member` | 0 | **0** |

(27/25 here vs 26/24 in my #121 evidence because this run also counts `settings.privacy`,
which that sweep's label list omitted. The before/after comparison is unaffected — same
list both sides.)

## 2. Why, verified rather than argued

Independently re-queried on `qa3_121`, one row per action:

```
browser-extension.read/.write, chat.write, embed.read/.write/.delete,
invite.create/.delete, model-router.read/.write   ->  all: super_admin:org
non-super_admin holders of any of the 10          ->  0 rows
```

Exposure adds a **key to the answer map**, not a grant. Visibility widens only if some role
holds a newly-exposed action *and* did not already see the entry it unlocks. Only
`super_admin` holds any of the ten, and it already holds all 11 currently-exposed actions —
so it already saw every entry these could unlock. Hence zero movement, and the recon's
count (10, not 12) is right: `workspace.delete` is already answered at workspace scope and
`org.member` is deliberately out per #53.

## 3. The direction that is *not* covered by this measurement

RF-C says the slice changes no visible set, and it does not. But this is the **M2 trap in
reverse**, and only one direction was tested here:

- **exposing an action nobody else holds** → no visibility change (proved above);
- **failing to expose an action a sidebar entry gates on** → the entry vanishes for
  *everyone*, `super_admin` included. That is the trap I measured on #137's Model Router
  re-gate (`26 → 25`), and it is what the pairing test in
  `workspaceScopedCapabilities.test.js` exists to catch.

So the slice is safe to land, **provided** the exact-list test's pin moves 11 → 21 in the
same commit. A commit that adds the actions without updating the literal fails that test; a
commit that updates the literal without adding the actions fails the pairing test. Both
directions already held — same as #121 and #137.

## 4. Standing note for the audit that follows

This slice makes those ten answerable but changes nothing on screen. Any *later* commit
that re-gates a sidebar entry onto one of them (the audit's likely output) does move
visibility, and each such move needs the #137 Model Router treatment: measure the per-role
set before and after, and fire the M2 mutant (re-gate without exposing) to confirm the
pairing test catches it.

## 5. Housekeeping

`server/endpoints/system.js` reverted; probe test file deleted; `/tmp/qa3-127`
`git status --porcelain` clean. `qa3_121` read-only. No commits.
