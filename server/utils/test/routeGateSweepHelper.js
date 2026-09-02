const fs = require("fs");
const path = require("path");
const express = require("express");

const SERVER_DIR = path.join(__dirname, "../..");

function buildRouter() {
  const app = express();
  const indexSource = fs.readFileSync(
    path.join(SERVER_DIR, "index.js"),
    "utf8"
  );
  const registrations =
    indexSource.match(/^[a-zA-Z]+\((?:app, )?apiRouter\);$/gm) ?? [];
  const skipped = [];

  for (const line of registrations) {
    const fnName = line.replace(/\((?:app, )?apiRouter\);$/, "");
    const requireMatch = indexSource.match(
      new RegExp(
        `\\{[^}]*\\b${fnName}\\b[^}]*\\}\\s*=\\s*require\\("([^"]+)"\\)`
      )
    );
    if (!requireMatch) {
      skipped.push(fnName);
      continue;
    }
    try {
      const register = require(path.join(SERVER_DIR, requireMatch[1]))[fnName];
      line.includes("(app, apiRouter);") ? register(app, app) : register(app);
    } catch (error) {
      // agentWebsocket needs express-ws; it registers no plain HTTP routes.
      skipped.push(`${fnName}: ${error.message}`);
    }
  }
  return { app, registrations, skipped };
}

module.exports = { buildRouter };
