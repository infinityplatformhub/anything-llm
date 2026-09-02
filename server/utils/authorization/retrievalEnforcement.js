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
//   2. It lives only in `isRowAllowed`, never in the pushdown predicate. Relaxing the
//      query itself would let unlabelled rows occupy topN slots and push the actor's own
//      documents out of the results — S-17 in reverse, a silent retrieval-quality loss
//      rather than a leak. The predicate always asks for the strict answer; this only
//      decides what to do with a row that came back unable to answer.
//
// Removed, not flipped, once the backfill (#56) has run everywhere: a flag that no longer
// has a legitimate reason to be set is a flag someone will set by accident.

const allowUnprovableRows = () =>
  "RETRIEVAL_FILTER_ALLOW_UNPROVABLE" in process.env;

module.exports = { allowUnprovableRows };
