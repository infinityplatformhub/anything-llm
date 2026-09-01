// Seam 09 public error surface. Drivers re-export these; catch sites import from here,
// never from a driver path (issue #14 / code-standards §"error placement").

class LeaseLostError extends Error {}
class ImpersonatedMutationError extends Error {}

module.exports = { LeaseLostError, ImpersonatedMutationError };
