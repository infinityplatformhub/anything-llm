function buildRouter() {
  const indexPath = require.resolve("../../index");
  delete require.cache[indexPath];
  const { app, ENDPOINT_REGISTRATIONS } = require(indexPath);
  return { app, registrations: ENDPOINT_REGISTRATIONS, skipped: [] };
}

module.exports = { buildRouter };
