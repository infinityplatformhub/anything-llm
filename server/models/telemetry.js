/**
 * Disabled telemetry adapter.
 *
 * Keep this API stable while callers are removed independently. All methods are
 * local no-ops and this module performs no network or persistent-storage access.
 */
const Telemetry = {
  id: async () => null,
  connect: async () => ({ client: null, distinctId: null }),
  isDev: () => false,
  client: () => null,
  runtime: () => "disabled",
  isOnCooldown: () => false,
  markOnCooldown: () => {},
  sendTelemetry: async () => {},
  flush: async () => {},
  setUid: async () => null,
  findOrCreateId: async () => null,
};

module.exports = { Telemetry };
