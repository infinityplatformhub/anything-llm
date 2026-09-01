// Seam 02 public error surface (issue #17, same pattern as #14: jobs/events errors.js).
// The T-2 engine throws these; catch sites import from here, never from a driver path.

class AuthorizationDeniedError extends Error {} // normal denied decision — carries reason, no existence leak
class AuthorizationContractError extends Error {} // invalid input to the engine
class AuthorizationUnavailableError extends Error {} // store failure — callers must fail closed (503)

module.exports = {
  AuthorizationDeniedError,
  AuthorizationContractError,
  AuthorizationUnavailableError,
};
