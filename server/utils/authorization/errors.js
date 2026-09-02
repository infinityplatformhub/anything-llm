// Seam 02 public error surface (issue #17, same pattern as #14: jobs/events errors.js).
// The T-2 engine throws these; catch sites import from here, never from a driver path.

class AuthorizationDeniedError extends Error {} // normal denied decision — carries reason, no existence leak
class AuthorizationContractError extends Error {} // invalid input to the engine
class AuthorizationUnavailableError extends Error {} // store failure — callers must fail closed (503)
// T-5 (#30): the configured vector provider cannot push an ACL filter down yet. Distinct
// from Unavailable (a transient store failure) because this one never resolves by
// retrying — the deployment must switch provider or wait for that driver to land. Named
// rather than generic so an operator reading the log knows which of the two they have.
class RetrievalFilterUnsupportedError extends Error {}

module.exports = {
  AuthorizationDeniedError,
  AuthorizationContractError,
  AuthorizationUnavailableError,
  RetrievalFilterUnsupportedError,
};
