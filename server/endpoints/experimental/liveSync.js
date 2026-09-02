const { DocumentSyncQueue } = require("../../models/documentSyncQueue");
const { Document } = require("../../models/documents");
const { emitAuditEvent } = require("../../utils/events");
const { SystemSettings } = require("../../models/systemSettings");
const { Telemetry } = require("../../models/telemetry");
const { reqBody } = require("../../utils/http");
const {
  featureFlagEnabled,
} = require("../../utils/middleware/featureFlagEnabled");
const {
  requirePermission,
} = require("../../utils/middleware/requirePermission");
const {
  orgResource,
  watchedDocumentInWorkspaceBySlug,
} = require("../../utils/middleware/resourceResolvers");
const { validWorkspaceSlug } = require("../../utils/middleware/validWorkspace");
const { validatedRequest } = require("../../utils/middleware/validatedRequest");

function liveSyncEndpoints(app) {
  if (!app) return;

  app.post(
    "/experimental/toggle-live-sync",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      try {
        const { updatedStatus = false } = reqBody(request);
        const newStatus =
          SystemSettings.validations.experimental_live_file_sync(updatedStatus);
        const currentStatus =
          (await SystemSettings.get({ label: "experimental_live_file_sync" }))
            ?.value || "disabled";
        if (currentStatus === newStatus)
          return response
            .status(200)
            .json({ liveSyncEnabled: newStatus === "enabled" });

        // Already validated earlier - so can hot update.
        // #59: `_updateSettings` returns `{success:false}` on failure rather than
        // throwing. Unchecked, a failed write fell straight through to the workers
        // being started and a 200 saying live sync was enabled — the setting says
        // disabled, the workers are running, and the operator was told it worked.
        const update = await SystemSettings._updateSettings({
          experimental_live_file_sync: newStatus,
        });
        if (!update.success)
          return response.status(500).json({
            liveSyncEnabled: currentStatus === "enabled",
            error: update.error ?? "Failed to update live sync setting.",
          });
        if (newStatus === "enabled") {
          await Telemetry.sendTelemetry("experimental_feature_enabled", {
            feature: "live_file_sync",
          });
          await emitAuditEvent("experimental_feature_enabled", {
            feature: "live_file_sync",
          });
          DocumentSyncQueue.bootWorkers();
        } else {
          DocumentSyncQueue.killWorkers();
        }

        response.status(200).json({ liveSyncEnabled: newStatus === "enabled" });
      } catch (e) {
        console.error(e);
        response.status(500).end();
      }
    }
  );

  app.get(
    "/experimental/live-sync/queues",
    [
      validatedRequest,
      requirePermission("system.read", orgResource),
      featureFlagEnabled(DocumentSyncQueue.featureKey),
    ],
    async (_, response) => {
      const queues = await DocumentSyncQueue.where(
        {},
        null,
        { createdAt: "asc" },
        {
          workspaceDoc: {
            include: {
              workspace: true,
            },
          },
        }
      );
      response.status(200).json({ queues });
    }
  );

  // Should be in workspace routes, but is here for now.
  app.post(
    "/workspace/:slug/update-watch-status",
    [
      validatedRequest,
      requirePermission("document.watch", watchedDocumentInWorkspaceBySlug),
      validWorkspaceSlug,
      featureFlagEnabled(DocumentSyncQueue.featureKey),
    ],
    async (request, response) => {
      try {
        const { docPath, watchStatus = false } = reqBody(request);
        const workspace = response.locals.workspace;

        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document) return response.sendStatus(404).end();

        await DocumentSyncQueue.toggleWatchStatus(document, watchStatus);
        return response.status(200).end();
      } catch (error) {
        console.error("Error processing the watch status update:", error);
        return response.status(500).end();
      }
    }
  );
}

module.exports = { liveSyncEndpoints };
