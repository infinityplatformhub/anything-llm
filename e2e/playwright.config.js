const { defineConfig } = require("@playwright/test");

// The E2E stack is `docker compose -f docker/docker-compose.yml -f e2e/docker-compose.e2e.yml`
// — this worktree's build on port 3101, host Ollama for LLM/embedding.
const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3111";

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // one instance, one flow — ordering is the point
  reporter: [["list"], ["html", { outputFolder: "report", open: "never" }]],
  use: {
    baseURL: BASE_URL,
    screenshot: "on",
    trace: "retain-on-failure",
    video: "off",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: "en-US",
  },
  outputDir: "artifacts",
});
