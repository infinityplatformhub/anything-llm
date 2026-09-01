// T-4a (#25): the legacy `users.role` VALUES, kept deliberately.
//
// P0-5 ruling R4: `users.role` is not dropped in Phase 0 — it is frozen and read
// only as legacy-migration input. Authorization no longer reads it; the engine
// decides access from grants. What still needs these values is role ASSIGNMENT
// (which role string an admin may hand another user), which is data validation,
// not an access decision.
//
// They live here rather than in the deleted multiUserProtected middleware so
// that nothing can import a role list and a bypass from the same module again.
const ROLES = {
  admin: "admin",
  manager: "manager",
  default: "default",
};

module.exports = { ROLES };
