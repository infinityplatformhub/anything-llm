// Seam 10 public error surface. Drivers re-export these; catch sites import from here,
// never from a driver path (issue #14 / code-standards §"error placement").

class EventConflictError extends Error {}
class UnknownEventVersionError extends Error {}

module.exports = { EventConflictError, UnknownEventVersionError };
