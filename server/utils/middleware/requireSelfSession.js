// #52: a self-service route acts on the CALLER'S OWN account — editing their
// profile, registering their own push endpoint. An impersonated session is by
// construction not the caller acting as themselves, so it may not use one.
//
// This is not the method-based guard Techlead rejected. That one refused every
// non-GET, which would have caught five POST routes gated on READ actions
// (local-files/by-docpaths, custom-models, event-logs, transcribe-audio,
// community-hub/item) that the engine correctly allows. This keys on what the
// ROUTE means, and is applied route by route rather than to a whole verb.
//
// It exists because there is no seeded action for "acting as yourself":
// `user.write` is held by super_admin alone and `member` holds only
// `chat.send`, so gating these routes on any existing action would lock every
// ordinary user out of their own profile. #53 adds that action, and when it
// lands this middleware should be REPLACED by it rather than kept alongside —
// a real action lets the engine answer, which is where the answer belongs.

const { emitAuditEvent } = require("../events");

const DENY_REASON = "impersonated_self_service_denied";

function requireSelfSession(_request, response, next) {
  if (!response.locals.impersonatedBy) return next();

  // Audited like an engine denial: a refusal nobody can see afterwards is the
  // same shape as the hole this closes — a support engineer reaching for a
  // victim's account should leave a record either way.
  emitAuditEvent(
    "authorization.denied",
    { action: "self_service", allowed: false, denyReason: DENY_REASON },
    response.locals.user?.id ?? null,
    { resource: { type: "user", id: String(response.locals.user?.id ?? "") } }
  ).catch((error) =>
    console.error("[requireSelfSession] audit emit failed:", error.message)
  );

  return response.status(403).json({
    error: "A view-as-user session cannot act on the account it is viewing.",
  });
}

module.exports = { requireSelfSession, DENY_REASON };
