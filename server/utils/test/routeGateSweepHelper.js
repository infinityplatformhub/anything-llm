const express = require("express");

function buildRouter(registrations) {
  const app = express();
  const entries =
    registrations || require("../../index").ENDPOINT_REGISTRATIONS;
  const skipped = [];

  for (const entry of entries) {
    const register = typeof entry === "function" ? entry : entry.register;
    try {
      typeof entry === "function" ? register(app) : register(app, app);
    } catch (error) {
      // agentWebsocket needs express-ws; it registers no plain HTTP routes.
      skipped.push(`${register.name}: ${error.message}`);
    }
  }
  return { app, registrations: entries, skipped };
}

module.exports = { buildRouter };
