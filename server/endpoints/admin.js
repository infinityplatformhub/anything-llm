const { ApiKey } = require("../models/apiKeys");
const { ADMIN_DEFAULT_SCOPES } = require("../utils/apiKeySecurity/scopes");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const { Document } = require("../models/documents");
const { emitAuditEvent } = require("../utils/events");
const { Invite } = require("../models/invite");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { DocumentVectors } = require("../models/vectors");
const { Workspace } = require("../models/workspace");
const { WorkspaceChats } = require("../models/workspaceChats");
const {
  getVectorDbClass,
  getEmbeddingEngineSelection,
} = require("../utils/helpers");
const {
  validRoleSelection,
  canModifyAdmin,
  validCanModify,
} = require("../utils/helpers/admin");
const {
  reqBody,
  userFromSession,
  safeJsonParse,
  makeJWT,
} = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { requirePermission } = require("../utils/middleware/requirePermission");
const {
  orgResource,
  workspaceByIdParam,
} = require("../utils/middleware/resourceResolvers");
const {
  DatabaseAuthorizationEngine,
} = require("../utils/authorization/engine");
const ImportedPlugin = require("../utils/agents/imported");
const {
  simpleSSOLoginDisabledMiddleware,
} = require("../utils/middleware/simpleSSOEnabled");
const {
  workspaceDeletionProtection,
} = require("../utils/middleware/workspaceDeletionProtection");

const authorizationEngine = new DatabaseAuthorizationEngine();

function adminEndpoints(app) {
  if (!app) return;

  app.get(
    "/admin/users",
    [validatedRequest, requirePermission("user.read", orgResource)],
    async (_request, response) => {
      try {
        const users = await User.where();
        response.status(200).json({ users });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/users/new",
    [validatedRequest, requirePermission("user.manage", orgResource)],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const newUserParams = reqBody(request);
        const roleValidation = await validRoleSelection(
          response.locals.actor,
          newUserParams
        );

        if (!roleValidation.valid) {
          response
            .status(200)
            .json({ user: null, error: roleValidation.error });
          return;
        }

        const { user: newUser, error } = await User.create(newUserParams);
        if (!!newUser) {
          await emitAuditEvent(
            "user_created",
            {
              userName: newUser.username,
              createdBy: currUser.username,
            },
            currUser.id
          );
        }

        response.status(200).json({ user: newUser, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/user/:id",
    [validatedRequest, requirePermission("user.manage", orgResource)],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const { id } = request.params;
        const updates = reqBody(request);
        const user = await User.get({ id: Number(id) });

        const canModify = await validCanModify(response.locals.actor, user);
        if (!canModify.valid) {
          response.status(200).json({ success: false, error: canModify.error });
          return;
        }

        const roleValidation = await validRoleSelection(
          response.locals.actor,
          updates
        );
        if (!roleValidation.valid) {
          response
            .status(200)
            .json({ success: false, error: roleValidation.error });
          return;
        }

        const validAdminRoleModification = await canModifyAdmin(user, updates);
        if (!validAdminRoleModification.valid) {
          response
            .status(200)
            .json({ success: false, error: validAdminRoleModification.error });
          return;
        }

        const { success, error } = await User.update(id, updates);
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/user/:id",
    [validatedRequest, requirePermission("user.manage", orgResource)],
    async (request, response) => {
      try {
        const currUser = await userFromSession(request, response);
        const { id } = request.params;
        const user = await User.get({ id: Number(id) });

        const canModify = await validCanModify(response.locals.actor, user);
        if (!canModify.valid) {
          response.status(200).json({ success: false, error: canModify.error });
          return;
        }

        await BrowserExtensionApiKey.deleteAllForUser(Number(id));
        await User.delete({ id: Number(id) });
        await emitAuditEvent(
          "user_deleted",
          {
            userName: user.username,
            deletedBy: currUser.username,
          },
          currUser.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // T-7 (#31, D-3): view-as-user. Issues a session that reads AS the target user
  // while remaining, provably, the admin's session.
  //
  // Until now `actorResolver` read `locals.impersonatedBy` and NOTHING wrote it,
  // so the engine's blanket mutation deny was correct, tested, and unreachable.
  // This is the write side.
  //
  // Read-only is NOT enforced here. The engine denies every non-read action for
  // an impersonated actor before any policy lookup (T-2), so a route that
  // forgets to check is still safe. Enforcing it here as well would create a
  // second answer that can disagree with the first.
  app.post(
    "/admin/view-as-user/:id",
    [validatedRequest, requirePermission("user.manage", orgResource)],
    async (request, response) => {
      try {
        const admin = await userFromSession(request, response);
        const targetId = Number(request.params.id);
        if (!Number.isInteger(targetId))
          return response.status(400).json({ error: "Invalid user id." });

        // No impersonating yourself, and no chaining: an already-impersonated
        // session must not mint another, or the provenance chain loses its head.
        if (response.locals.impersonatedBy)
          return response
            .status(403)
            .json({ error: "An impersonated session cannot impersonate." });
        if (targetId === admin?.id)
          return response
            .status(400)
            .json({ error: "You are already yourself." });

        const target = await User.get({ id: targetId });
        if (!target) return response.sendStatus(404);
        if (target.suspended)
          return response
            .status(400)
            .json({ error: "Cannot view as a suspended user." });

        // The provenance is IN the token, not alongside it: a claim the holder
        // could drop would let them upgrade a read-only session to a real one.
        // Short-lived by design — this is a support tool, not a login.
        const token = makeJWT(
          { id: target.id, username: target.username, impersonatedBy: admin.id },
          "30m"
        );

        await emitAuditEvent(
          "admin_view_as_user",
          { targetUserId: target.id, targetUsername: target.username },
          admin?.id
        );

        response.status(200).json({
          token,
          user: User.filterFields(target),
          impersonatedBy: admin.id,
          readOnly: true,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/invites",
    [validatedRequest, requirePermission("invite.read", orgResource)],
    async (_request, response) => {
      try {
        const invites = await Invite.whereWithUsers();
        response.status(200).json({ invites });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/invite/new",
    [
      validatedRequest,
      requirePermission("invite.create", orgResource),
      simpleSSOLoginDisabledMiddleware,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);
        const { invite, error } = await Invite.create({
          createdByUserId: user.id,
          workspaceIds: body?.workspaceIds || [],
        });

        await emitAuditEvent(
          "invite_created",
          {
            inviteCode: invite.code,
            createdBy: response.locals?.user?.username,
          },
          response.locals?.user?.id
        );
        response.status(200).json({ invite, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/invite/:id",
    [validatedRequest, requirePermission("invite.delete", orgResource)],
    async (request, response) => {
      try {
        const { id } = request.params;
        const { success, error } = await Invite.deactivate(id);
        await emitAuditEvent(
          "invite_deleted",
          { deletedBy: response.locals?.user?.username },
          response.locals?.user?.id
        );
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/workspaces",
    [validatedRequest, requirePermission("workspace.read", orgResource)],
    async (_request, response) => {
      try {
        const workspaces = await Workspace.whereWithUsers();
        response.status(200).json({ workspaces });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/workspaces/:workspaceId/users",
    [
      validatedRequest,
      requirePermission(
        "workspace.members.manage",
        workspaceByIdParam("workspaceId")
      ),
    ],
    async (request, response) => {
      try {
        const { workspaceId } = request.params;
        const users = await Workspace.workspaceUsers(workspaceId);
        response.status(200).json({ users });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/workspaces/new",
    [validatedRequest, requirePermission("workspace.create", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name } = reqBody(request);
        const { workspace, message: error } = await Workspace.new(
          name,
          user.id
        );
        response.status(200).json({ workspace, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/workspaces/:workspaceId/update-users",
    [
      validatedRequest,
      requirePermission(
        "workspace.members.manage",
        workspaceByIdParam("workspaceId")
      ),
    ],
    async (request, response) => {
      try {
        const { workspaceId } = request.params;
        const { userIds } = reqBody(request);
        const { success, error } = await Workspace.updateUsers(
          workspaceId,
          userIds
        );
        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/workspaces/:id",
    [
      validatedRequest,
      requirePermission("workspace.delete", workspaceByIdParam("id")),
      workspaceDeletionProtection,
    ],
    async (request, response) => {
      try {
        const { id } = request.params;
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ id: Number(id) });
        if (!workspace) {
          response.sendStatus(404).end();
          return;
        }

        await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
        await DocumentVectors.deleteForWorkspace(Number(workspace.id));
        await Document.delete({ workspaceId: Number(workspace.id) });
        await Workspace.delete({ id: Number(workspace.id) });
        try {
          await VectorDb["delete-namespace"]({ namespace: workspace.slug });
        } catch (e) {
          console.error(e.message);
        }

        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // System preferences but only by array of labels
  app.get(
    "/admin/system-preferences-for",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      try {
        const requestedSettings = {};
        const labels = request.query.labels?.split(",") || [];
        const needEmbedder = [
          "text_splitter_chunk_size",
          "max_embed_chunk_size",
        ];
        const noRecord = [
          "max_embed_chunk_size",
          "agent_sql_connections",
          "imported_agent_skills",
          "feature_flags",
          "meta_page_title",
          "meta_page_favicon",
        ];

        // Managers can only read a limited set of settings.
        // These match the ManagerRoute pages in the frontend.
        const managerAllowedFields = [
          "custom_app_name",
          "footer_data",
          "support_email",
          "meta_page_title",
          "meta_page_favicon",
        ];

        const unrestrictedSettings = await authorizationEngine.authorize({
          actor: response.locals.actor,
          action: "system.write",
          resource: await orgResource(),
        });

        for (const label of labels) {
          // Skip any settings that are not explicitly defined as public
          if (!SystemSettings.publicFields.includes(label)) continue;

          // Callers without broad system write access can only read manager fields.
          if (
            !unrestrictedSettings.allowed &&
            !managerAllowedFields.includes(label)
          )
            continue;

          // Only get the embedder if the setting actually needs it
          let embedder = needEmbedder.includes(label)
            ? getEmbeddingEngineSelection()
            : null;
          // Only get the record from db if the setting actually needs it
          let setting = noRecord.includes(label)
            ? null
            : await SystemSettings.get({ label });

          switch (label) {
            case "footer_data":
              requestedSettings[label] = setting?.value ?? JSON.stringify([]);
              break;
            case "support_email":
              requestedSettings[label] = setting?.value || null;
              break;
            case "text_splitter_chunk_size":
              requestedSettings[label] =
                setting?.value || embedder?.embeddingMaxChunkLength || null;
              break;
            case "text_splitter_chunk_overlap":
              requestedSettings[label] = setting?.value || null;
              break;
            case "max_embed_chunk_size":
              requestedSettings[label] =
                embedder?.embeddingMaxChunkLength || 1000;
              break;
            case "agent_search_provider":
              requestedSettings[label] = setting?.value || null;
              break;
            case "agent_sql_connections":
              requestedSettings[label] =
                await SystemSettings.agent_sql_connections();
              break;
            case "default_agent_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_agent_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_filesystem_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_create_files_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_gmail_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "disabled_outlook_skills":
              requestedSettings[label] = safeJsonParse(setting?.value, []);
              break;
            case "imported_agent_skills":
              requestedSettings[label] = ImportedPlugin.listImportedPlugins();
              break;
            case "custom_app_name":
              requestedSettings[label] = setting?.value || null;
              break;
            case "feature_flags":
              requestedSettings[label] =
                (await SystemSettings.getFeatureFlags()) || {};
              break;
            case "meta_page_title":
              requestedSettings[label] =
                await SystemSettings.getValueOrFallback({ label }, null);
              break;
            case "meta_page_favicon":
              requestedSettings[label] =
                await SystemSettings.getValueOrFallback({ label }, null);
              break;
            case "memory_enabled":
              requestedSettings[label] = setting?.value || "false";
              break;
            case "memory_auto_extraction":
              requestedSettings[label] = setting?.value ?? "true";
              break;
            default:
              break;
          }
        }

        response.status(200).json({ settings: requestedSettings });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/admin/system-preferences",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        let updates = reqBody(request);

        // Callers without broad system write access can update manager fields only.
        const unrestrictedSettings = await authorizationEngine.authorize({
          actor: response.locals.actor,
          action: "system.write",
          resource: await orgResource(),
        });
        if (!unrestrictedSettings.allowed) {
          const managerAllowedFields = [
            "custom_app_name",
            "footer_data",
            "support_email",
            "meta_page_title",
            "meta_page_favicon",
          ];
          const filteredUpdates = {};
          for (const key of Object.keys(updates)) {
            if (managerAllowedFields.includes(key)) {
              filteredUpdates[key] = updates[key];
            }
          }
          updates = filteredUpdates;
        }

        await SystemSettings.updateSettings(updates);
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/admin/api-keys",
    [validatedRequest, requirePermission("key.manage", orgResource)],
    async (_request, response) => {
      try {
        const apiKeys = await ApiKey.whereWithUser({});
        return response.status(200).json({
          apiKeys,
          error: null,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          apiKey: null,
          error: "Could not find an API Keys.",
        });
      }
    }
  );

  app.post(
    "/admin/generate-api-key",
    [validatedRequest, requirePermission("key.manage", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name = null, scopes = null } = reqBody(request);
        // PR-4c: a key is minted with an enumerated scope list, never a wildcard. A
        // caller may name its scopes; omitting them takes the admin preset rather than
        // everything, so an unmodified client keeps working without minting a god key.
        const { apiKey, error } = await ApiKey.create(user.id, name, {
          scopes: Array.isArray(scopes) && scopes.length ? scopes : [...ADMIN_DEFAULT_SCOPES],
        });
        if (error) return response.status(400).json({ apiKey: null, error });
        await emitAuditEvent(
          "api_key_created",
          { createdBy: user?.username, name: apiKey?.name },
          user?.id
        );
        return response.status(200).json({
          apiKey,
          error,
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/admin/delete-api-key/:id",
    [validatedRequest, requirePermission("key.manage", orgResource)],
    async (request, response) => {
      try {
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();
        await ApiKey.delete({ id: Number(id) });

        await emitAuditEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { adminEndpoints };
