// T-5 (#30): RETRIEVAL_FILTER_ALLOW_UNPROVABLE — the escape hatch for vectors written
// before the ACL metadata existed.
//
// The filter's rule is "unprovable means denied" (S-26/G4). Every vector embedded before
// T-5 carries no orgId/workspaceId/docId, so a deployment that upgrades before running the
// backfill would lose retrieval for all of its existing documents.
//
// The default is still FAIL-CLOSED. A deployment in that position must SAY SO by setting
// this variable — the unsafe state is opt-in and visible in the environment, rather than
// the default everyone silently inherits. That is the inverse of the shape I first built
// (an "enforce" flag defaulting off), and it is the right way round: the safe reading is
// what you get for free.
//
// Two hard boundaries:
//
//   1. It applies ONLY at the point where a row has no ACL metadata at all. A row that
//      HAS metadata is judged identically in both states — another org's row, a revoked
//      document and a match-none actor stay denied whatever this is set to. The flag
//      governs absence of evidence, never evidence of denial.
//   2. It applies in BOTH the pushdown predicate and `isRowAllowed`, as one all-or-nothing
//      clause: `((orgId IS NULL AND workspaceId IS NULL AND docId IS NULL) OR (<strict>))`.
//
//      An earlier version of this put the hatch only in `isRowAllowed` and left the
//      predicate strict, reasoning that relaxing the query would let unlabelled rows
//      occupy topN slots. That reasoning was about a real cost but produced a flag that
//      did NOTHING: `orgId = '1'` removed every unlabelled row inside the query, so the
//      row check never saw one, while the boot report told operators those rows were
//      being served. A flag that does nothing is worse than no flag.
//
//      The accepted cost, until the backfill (#56) lands: in the flagged state unlabelled
//      rows do compete for result slots and can crowd out labelled ones. The boot report
//      says so. A degraded ranking that works beats a pristine ranking that ignores the
//      operator's only lever.
//
//      All-or-nothing matters: a per-field `IS NULL OR` would admit half-labelled rows —
//      one claiming an orgId but no workspaceId would pass the workspace check by having
//      no workspace. Only the pre-T-5 shape is excused.
//
// Removed, not flipped, once the backfill (#56) has run everywhere: a flag that no longer
// has a legitimate reason to be set is a flag someone will set by accident.

const allowUnprovableRows = () =>
  "RETRIEVAL_FILTER_ALLOW_UNPROVABLE" in process.env;

module.exports = { allowUnprovableRows };
