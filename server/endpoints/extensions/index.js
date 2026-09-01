const { Telemetry } = require("../../models/telemetry");
const { CollectorApi } = require("../../utils/collectorApi");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");
const {
  requirePermission,
} = require("../../utils/middleware/requirePermission");
const { orgResource } = require("../../utils/middleware/resourceResolvers");
const {
  isSupportedRepoProvider,
} = require("../../utils/middleware/isSupportedRepoProviders");

function extensionEndpoints(app) {
  if (!app) return;

  app.post(
    "/ext/:repo_platform/branches",
    [
      validatedRequest,
      requirePermission("document.create", orgResource),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo/branches`,
            method: "POST",
            body: request.body,
          });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/:repo_platform/repo",
    [
      validatedRequest,
      requirePermission("document.create", orgResource),
      isSupportedRepoProvider,
    ],
    async (request, response) => {
      try {
        const { repo_platform } = request.params;
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: `/ext/${repo_platform}-repo`,
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: `${repo_platform}_repo`,
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/youtube/transcript",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/youtube-transcript",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "youtube_transcript",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/confluence",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/confluence",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "confluence",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
  app.post(
    "/ext/website-depth",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/website-depth",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "website_depth",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
  app.post(
    "/ext/drupalwiki",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/drupalwiki",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "drupalwiki",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/obsidian/vault",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/obsidian/vault",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "obsidian_vault",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/ext/paperless-ngx",
    [validatedRequest, requirePermission("document.create", orgResource)],
    async (request, response) => {
      try {
        const responseFromProcessor =
          await new CollectorApi().forwardExtensionRequest({
            endpoint: "/ext/paperless-ngx",
            method: "POST",
            body: request.body,
          });
        await Telemetry.sendTelemetry("extension_invoked", {
          type: "paperless_ngx",
        });
        response.status(200).json(responseFromProcessor);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { extensionEndpoints };
