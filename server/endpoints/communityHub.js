const { SystemSettings } = require("../models/systemSettings");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { requirePermission } = require("../utils/middleware/requirePermission");
const { orgResource } = require("../utils/middleware/resourceResolvers");
const { reqBody } = require("../utils/http");
const {
  narrowManagerSystemPreferences,
} = require("../utils/managerSystemPreferences");
const { CommunityHub } = require("../models/communityHub");
const {
  communityHubDownloadsEnabled,
  communityHubItem,
} = require("../utils/middleware/communityHubDownloadsEnabled");
const { emitAuditEvent } = require("../utils/events");
const { Telemetry } = require("../models/telemetry");

function communityHubEndpoints(app) {
  if (!app) return;

  app.get(
    "/community-hub/settings",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (_, response) => {
      try {
        const { connectionKey } = await SystemSettings.hubSettings();
        response.status(200).json({ success: true, connectionKey });
      } catch (error) {
        console.error(error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/community-hub/settings",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      try {
        // #78 then #72, in that order: authority before vocabulary. A manager may
        // not write these keys at all, so that is settled before we ask whether the
        // names are ones the model knows.
        const narrowed = await narrowManagerSystemPreferences(
          response.locals.actor,
          reqBody(request)
        );
        if (narrowed.refusal)
          return response.status(403).json(narrowed.refusal);
        const result = await SystemSettings.updateSettings(narrowed.updates);
        if (["unknown_keys", "protected_keys"].includes(result.code))
          return response.status(400).json(result);
        if (!result.success) throw new Error(result.error);
        response.status(200).json(result);
      } catch (error) {
        console.error(error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.get(
    "/community-hub/explore",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (_, response) => {
      try {
        const exploreItems = await CommunityHub.fetchExploreItems();
        response.status(200).json({ success: true, result: exploreItems });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          success: false,
          result: null,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/community-hub/item",
    [
      validatedRequest,
      requirePermission("system.read", orgResource),
      communityHubItem,
    ],
    async (_request, response) => {
      try {
        response.status(200).json({
          success: true,
          item: response.locals.bundleItem,
          error: null,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          success: false,
          item: null,
          error: error.message,
        });
      }
    }
  );

  /**
   * Apply an item to the ApproofWorkspace instance. Used for simple items like slash commands and system prompts.
   */
  app.post(
    "/community-hub/apply",
    [
      validatedRequest,
      requirePermission("system.write", orgResource),
      communityHubItem,
    ],
    async (request, response) => {
      try {
        const { options = {} } = reqBody(request);
        const item = response.locals.bundleItem;
        const { error: applyError } = await CommunityHub.applyItem(item, {
          ...options,
          currentUser: response.locals?.user,
        });
        if (applyError) throw new Error(applyError);

        await Telemetry.sendTelemetry("community_hub_import", {
          itemType: response.locals.bundleItem.itemType,
          visibility: response.locals.bundleItem.visibility,
        });
        await emitAuditEvent(
          "community_hub_import",
          {
            itemId: response.locals.bundleItem.id,
            itemType: response.locals.bundleItem.itemType,
          },
          response.locals?.user?.id
        );

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  /**
   * Import a bundle item to the ApproofWorkspace instance by downloading the zip file and importing it.
   * or whatever the item type requires. This is not used if the item is a simple text responses like
   * slash commands or system prompts.
   */
  app.post(
    "/community-hub/import",
    [
      validatedRequest,
      requirePermission("system.write", orgResource),
      communityHubItem,
      communityHubDownloadsEnabled,
    ],
    async (_, response) => {
      try {
        const { error: importError } = await CommunityHub.importBundleItem({
          url: response.locals.bundleUrl,
          item: response.locals.bundleItem,
        });
        if (importError) throw new Error(importError);

        await Telemetry.sendTelemetry("community_hub_import", {
          itemType: response.locals.bundleItem.itemType,
          visibility: response.locals.bundleItem.visibility,
        });
        await emitAuditEvent(
          "community_hub_import",
          {
            itemId: response.locals.bundleItem.id,
            itemType: response.locals.bundleItem.itemType,
          },
          response.locals?.user?.id
        );

        response.status(200).json({ success: true, error: null });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.get(
    "/community-hub/items",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (_, response) => {
      try {
        const { connectionKey } = await SystemSettings.hubSettings();
        const items = await CommunityHub.fetchUserItems(connectionKey);
        response.status(200).json({ success: true, ...items });
      } catch (error) {
        console.error(error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );

  app.post(
    "/community-hub/:communityHubItemType/create",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const { communityHubItemType } = request.params;
        const { connectionKey } = await SystemSettings.hubSettings();
        if (!connectionKey)
          throw new Error("Community Hub connection key not found");

        const data = reqBody(request);
        const { success, error, itemId } = await CommunityHub.createStaticItem(
          communityHubItemType,
          data,
          connectionKey
        );
        if (!success) throw new Error(error);

        await emitAuditEvent(
          "community_hub_publish",
          { itemType: communityHubItemType },
          response.locals?.user?.id
        );
        response
          .status(200)
          .json({ success: true, error: null, item: { id: itemId } });
      } catch (error) {
        console.error(error);
        response.status(500).json({ success: false, error: error.message });
      }
    }
  );
}

module.exports = { communityHubEndpoints };
