
## PMO dispatch rules (user ruling 2026-09-02)

- **Reject = lesson.** Every time a reviewer rejects or finds a defect in a SHA, the PMO must (1) name the failure class in one line, (2) put that line into the *next dispatch to every dev* as a "do not repeat" item, and (3) append it to `docs/superpowers/design/code-standards.md` §7.17 with the issue number. A rejection that only goes back to the one dev who made it is a dispatch failure.
- **Rulings that touch code structure go through a Techlead first.** No structural ruling from a summary alone (3 wrong rulings on 2026-09-02: #96 reuse, #40 workspace.orgId, #97 option 1).
- **Assign work so lanes never overlap files.** Before dispatch, check the file lane of every in-flight issue; two devs in one file = one of them waits.
- **§7.11a risk tiers.** PMO classifies each issue at contract time: `auth` (auth/permission/schema/secrets/anything exposed unauthenticated) = full QA + Techlead verdict before merge; `plain` = gate + Techlead pre-read only, merge on gate PASS. Dev never self-classifies. Misclassification found in review reclassifies to `auth` immediately.
- **Reviewers use the skill-first table (user ruling 2026-09-02).** Techlead verdicts go through `requesting-code-review`; auth-tier issues add `security-review`; §7.17 lines go through `infi-lessons`. The first line of every verdict and evidence file names the skills invoked. PMO rejects a verdict that does not.
