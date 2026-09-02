/**
 * #59 (b): toggling live sync must not report success for a setting it failed to write.
 *
 * `SystemSettings._updateSettings` returns `{success:false}` rather than throwing.
 * Unchecked, the handler fell through to starting the sync workers and answering 200 —
 * so the setting said "disabled", the workers were running, and the operator was told
 * it worked. Three states that cannot all be true.
 *
 * Driven at the handler rather than over the full HTTP stack: the route sits behind a
 * feature flag and session auth, and neither is what this asserts. Mounting the router
 * alone keeps the subject the write-result check.
 */
const express = require("express");
const request = require("supertest");

jest.mock("../../models/systemSettings", () => ({
  SystemSettings: {
    _updateSettings: jest.fn(),
    get: jest.fn(),
    // Mirrors the real validator (systemSettings.js:414): anything that is not
    // "enabled"/"disabled" becomes "disabled", which is what makes the handler's
    // "no change" short-circuit fire on a bad value.
    validations: {
      experimental_live_file_sync: jest.fn((update) => {
        if (typeof update === "boolean") return update ? "enabled" : "disabled";
        if (!["enabled", "disabled"].includes(update)) return "disabled";
        return String(update);
      }),
    },
  },
}));
jest.mock("../../models/documentSyncQueue", () => ({
  DocumentSyncQueue: {
    bootWorkers: jest.fn(),
    killWorkers: jest.fn(),
    enabled: jest.fn(async () => false),
  },
}));
jest.mock("../../models/telemetry", () => ({
  Telemetry: { sendTelemetry: jest.fn() },
}));
jest.mock("../../utils/events", () => ({ emitAuditEvent: jest.fn() }));
jest.mock("../../utils/managerSystemPreferences", () => ({
  narrowManagerSystemPreferences: jest.fn(async (_actor, updates) => ({
    updates,
  })),
}));
// The two guards are not the subject; a real session and a real flag would only make
// this a test of those.
jest.mock("../../utils/middleware/validatedRequest", () => ({
  validatedRequest: (_request, _response, next) => next(),
}));
jest.mock("../../utils/middleware/requirePermission", () => ({
  requirePermission: () => (_request, _response, next) => next(),
}));
jest.mock("../../utils/middleware/featureFlagEnabled", () => ({
  featureFlagEnabled: () => (_request, _response, next) => next(),
}));

const { SystemSettings } = require("../../models/systemSettings");
const { DocumentSyncQueue } = require("../../models/documentSyncQueue");
const { liveSyncEndpoints } = require("../../endpoints/experimental/liveSync");

function app() {
  const server = express();
  server.use(express.json());
  liveSyncEndpoints(server);
  return server;
}

const toggle = (updatedStatus) =>
  request(app()).post("/experimental/toggle-live-sync").send({ updatedStatus });

beforeEach(() => {
  jest.clearAllMocks();
  // Currently disabled, so enabling is a real change and the handler proceeds.
  SystemSettings.get.mockResolvedValue({ value: "disabled" });
});

describe("a failed settings write", () => {
  beforeEach(() => {
    SystemSettings._updateSettings.mockResolvedValue({
      success: false,
      error: "system_settings unavailable",
    });
  });

  it("answers 500, not 200", async () => {
    const response = await toggle("enabled");

    expect(response.status).toBe(500);
  });

  it("reports the setting as still disabled, not as enabled", async () => {
    // Echoing the requested state back would tell the operator the toggle took effect.
    const response = await toggle("enabled");

    expect(response.body.liveSyncEnabled).toBe(false);
  });

  it("does not start the sync workers", async () => {
    // The worst of the three states: workers running against a setting that says off,
    // which nothing later would reconcile.
    await toggle("enabled");

    expect(DocumentSyncQueue.bootWorkers).not.toHaveBeenCalled();
  });

  it("does not kill them either when the write to disable fails", async () => {
    SystemSettings.get.mockResolvedValue({ value: "enabled" });

    await toggle("disabled");

    expect(DocumentSyncQueue.killWorkers).not.toHaveBeenCalled();
  });
});

describe("a successful settings write (positive control)", () => {
  beforeEach(() => {
    SystemSettings._updateSettings.mockResolvedValue({
      success: true,
      error: null,
    });
  });

  it("answers 200 and starts the workers", async () => {
    // Without this, every case above is equally consistent with a handler that refuses
    // everything.
    const response = await toggle("enabled");

    expect(response.status).toBe(200);
    expect(response.body.liveSyncEnabled).toBe(true);
    expect(DocumentSyncQueue.bootWorkers).toHaveBeenCalled();
  });

  it("kills the workers when disabling", async () => {
    SystemSettings.get.mockResolvedValue({ value: "enabled" });

    const response = await toggle("disabled");

    expect(response.status).toBe(200);
    expect(DocumentSyncQueue.killWorkers).toHaveBeenCalled();
  });
});
