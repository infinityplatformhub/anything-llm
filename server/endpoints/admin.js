const { ApiKey } = require("../models/apiKeys");
const { ADMIN_DEFAULT_SCOPES } = require("../utils/apiKeySecurity/scopes");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const { Document } = require("../models/documents");
const { emitAuditEvent } = require("../utils/events");
const { Invite } = require("../models/invite");
const { SystemSettings } = require("../models/systemSettings");
const { User, revokeCredentialsFor } = require("../models/user");
const prisma = require("../utils/prisma");
const {
  removeGroupMember,
  offboardUser,
} = require("../utils/authorization/policyRepository");
const {
  AuthorizationContractError,
} = require("../utils/authorization/errors");
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

const {
  InviteMailError,
  requestedAddress,
  assertChannelReady,
  sendInvite,
} = require("../utils/notifications/inviteMailer");
const {
  inviteMailRateLimit,
  whenMailing,
} = require("../utils/middleware/requestControls");

const authorizationEngine = new DatabaseAuthorizationEngine();

const {
  managerAllowedFields,
  narrowManagerSystemPreferences,
} = require("../utils/managerSystemPreferences");

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
        // #135: revoke the authority BEFORE the row goes, in ONE transaction with the
        // delete. `principal_id` is TEXT with no foreign key in
        // `principal_role_grants` and `document_acl`, so deleting the user leaves those
        // rows behind — and ids are reused (sqlite-to-pg-import.js:102 calls setval),
        // which hands the next account the old one's grants.
        //
        // One transaction rather than two sequential calls: a crash between them
        // recreates the orphan by another route, which is the same bug arriving through
        // a narrower window.
        //
        // The actor is this route's own session principal, the same one
        // `validCanModify` was checked against above. A principal without `role.revoke`
        // is refused, and the refusal aborts the delete — see the catch below.
        await prisma.$transaction(async (tx) => {
          await offboardUser({
            actor: response.locals.actor,
            userId: Number(id),
            db: tx,
          });
          // The same credential revocation `User.delete` performs — reused, not
          // reimplemented, so the stamp cannot drift between the two paths.
          await revokeCredentialsFor(Number(id), tx);
          await tx.users.delete({ where: { id: Number(id) } });
        });
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
        // #135: a refusal is a 403 that NAMES the missing permission, not a bare 500.
        // "Internal server error" for "you may not revoke grants" sends the operator
        // looking for an outage, and the transaction above already rolled back — the
        // user and their grants are intact, which is what the message should say.
        if (e instanceof AuthorizationContractError) {
          // #135: 403, not the 500 `requirePermission` would produce for this error
          // (middleware/requirePermission.js:92) — the request was understood and
          // refused, and 500 sends the operator looking for an outage.
          //
          // The body is the same "Forbidden." every other route answers with. Which
          // PERMISSION was missing is recorded server-side instead: telling an
          // unauthorized caller exactly which grant would have let them through is a
          // probing oracle, and the operator who needs it can read the log.
          console.error(
            `[#135] user deletion refused: ${e.message} (actor lacked role.revoke)`
          );
          response.status(403).json({ error: "Forbidden." });
          return;
        }
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // S12 slice 1 (#136): the first production caller of `removeGroupMember`.
  //
  // The repository function has been correct and tested since it was written —
  // it deletes the membership and bumps the `group_membership` policy version in
  // ONE transaction — but every reference to it lived in its own test file, so
  // no operator could ever take a user out of a group. Offboarding is what needs
  // it: a suspended account that is still a group member still appears in every
  // "who is in this group" answer.
  //
  // `user.manage`, not a group-specific action: no `group.*` permission is
  // seeded, and inventing one here would add a permission row with a single call
  // site. #136 records that as a residual rather than guessing at a taxonomy.
  //
  // The gate answers about the ORG, because group membership is org-scoped —
  // `removeGroupMember` derives the workspace keys it invalidates from the
  // membership row itself, not from anything the caller sends (B-3).
  app.delete(
    "/admin/group/:groupId/member/:userId",
    [validatedRequest, requirePermission("user.manage", orgResource)],
    async (request, response) => {
      try {
        // Parse FIRST, then check existence, and answer 404 before any
        // repository call. Both halves are load-bearing and were measured
        // separately: `999999` reached `removeGroupMember`, which bumps a policy
        // version unconditionally and — because `workspaceScopeKeysFor` falls
        // back to `orgId ?? 1` when it finds nothing — published that bump under
        // `org:1`, flushing every cached decision in the instance. `"abc"`
        // became `NaN` and threw inside the repository as a 500. An existence
        // check alone fixes only the first; `Number.isInteger` alone fixes only
        // the second.
        const groupId = Number(request.params.groupId);
        const userId = Number(request.params.userId);
        if (!Number.isInteger(groupId) || !Number.isInteger(userId))
          return response.sendStatus(404);

        const user = await User.get({ id: userId });
        if (!user) return response.sendStatus(404);
        const group = await prisma.groups.findUnique({
          where: { id: groupId },
        });
        if (!group) return response.sendStatus(404);

        const canModify = await validCanModify(response.locals.actor, user);
        if (!canModify.valid)
          return response
            .status(200)
            .json({ success: false, error: canModify.error });

        // `actor` comes from `response.locals`, which `requirePermission` set
        // after the engine allowed the call. `removeGroupMember` refuses an
        // escalation with it, so passing the session user instead would hand the
        // repository a principal the gate never checked.
        await removeGroupMember({
          actor: response.locals.actor,
          groupId,
          userId,
        });

        await emitAuditEvent(
          "group_member_removed",
          { userName: user.username, groupId },
          response.locals.user?.id
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
  // Read-only is NOT enforced here: the engine denies every non-read action for
  // an impersonated actor before any policy lookup (T-2).
  //
  // #52 corrects what this comment used to claim. It said a route that forgets
  // to check is "still safe" — untrue. The engine's deny only runs where a route
  // ASKS the engine, and `POST /system/user` carried `validatedRequest` alone,
  // so an impersonated session could set the victim's username and password and
  // then log in as them for real. The blanket deny is a backstop for routes that
  // ask, not a guarantee for routes that do not: every mutating route needs its
  // own gate, and the router sweep test is what keeps that true as routes are
  // added.
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
          {
            id: target.id,
            username: target.username,
            impersonatedBy: admin.id,
          },
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
        // TL-1: full addresses only for a caller who may manage users. Holding
        // `invite.read` means "may see the invites", not "may see who we
        // contacted" — and this listing is the one place that distinction is
        // visible.
        const maySeeAddresses = await authorizationEngine.authorize({
          actor: response.locals.actor,
          action: "user.manage",
          resource: await orgResource(),
        });
        const invites = await Invite.whereWithUsers({}, undefined, {
          unmaskEmail: maySeeAddresses.allowed,
        });
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
      // S11a (#80): metered only when it will actually send. A copy-link invite
      // costs a row; a mailed one costs a relay round trip and a slice of this
      // deployment's sending reputation, and the budget is for the second.
      whenMailing(inviteMailRateLimit),
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const body = reqBody(request);

        // S11a (#80), ruling D. Everything that can refuse happens BEFORE the
        // invite exists: a created-but-unsent invite is a code an admin cannot
        // see and did not ask for.
        const address = requestedAddress(body);
        if (address) {
          // Minting a link the admin hands over themselves is one capability;
          // sending mail from this deployment's domain to an address of the
          // caller's choosing is another, and `invite.create` alone does not
          // grant it.
          const mayMail = await authorizationEngine.authorize({
            actor: response.locals.actor,
            action: "user.manage",
            resource: await orgResource(),
          });
          if (!mayMail.allowed)
            return response.status(403).json({
              invite: null,
              error:
                "Sending an invitation by email requires user management permission. Create the invite without an address to share the link yourself.",
            });
          // Refuses when the channel is off or unverified, so the 4xx arrives
          // instead of a 200 that invited nobody.
          await assertChannelReady();
        }

        const { invite, error } = await Invite.create({
          createdByUserId: user.id,
          workspaceIds: body?.workspaceIds || [],
          email: address,
        });

        // #71: the invite's ID, never its CODE. The code redeems an account
        // through a public route and never expires, and audit rows are built to
        // be exported — so a code here is a live credential leaving the system.
        // The id says which invite without carrying anything redeemable.
        // The audit row records THAT an invite was mailed, never to whom: an
        // address is personal data, and #71's rule is that the allowlist does
        // not grow to accommodate a new call site.
        await emitAuditEvent(
          "invite_created",
          {
            inviteId: invite.id,
            createdBy: response.locals?.user?.username,
          },
          response.locals?.user?.id
        );

        if (address && invite) {
          try {
            await sendInvite({
              invite,
              address,
              appUrl: `${request.protocol}://${request.get("host")}`,
            });
          } catch (mailError) {
            // The invite exists and its code is in the response, so the admin is
            // not stranded — but they must be told the mail did not go, or they
            // will wait for someone who was never contacted. Only the message,
            // never the error object: a transport error can carry the
            // credential.
            console.error("[invite-mail] send failed:", mailError.message);
            // TL-1 NIT-2: `mailed` is a FIELD, so the UI branches on a boolean
            // rather than string-matching an error message that will be
            // translated and reworded. The invite exists and its code is in the
            // response, so the admin is not stranded — but they must be told the
            // mail did not go, or they wait for someone never contacted.
            return response.status(200).json({
              invite,
              mailed: false,
              error:
                "The invite was created but the email could not be sent. Share the link directly.",
            });
          }
        }

        response.status(200).json({ invite, mailed: Boolean(address), error });
      } catch (e) {
        // A refusal the caller can act on — bad address, channel off, not
        // verified — carries its own status. Anything else is ours, and stays a
        // 500 with nothing echoed back.
        if (e instanceof InviteMailError)
          return response
            .status(e.status)
            .json({ invite: null, error: e.message });
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
    // #52: user.manage, NOT org-wide workspace.read. This lists every workspace
    // and its members, which is user administration. Migration 044000
    // deliberately took org-wide workspace.read away from `member` (it made the
    // engine treat a NULL-workspace grant as every workspace); gating an admin
    // route on it would mean granting it back the moment any ordinary role
    // needs workspace.read for its own scope.
    [validatedRequest, requirePermission("user.manage", orgResource)],
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

        // Decide authority before updateSettings validates the setting vocabulary.
        const narrowed = await narrowManagerSystemPreferences(
          response.locals.actor,
          updates
        );
        if (narrowed.refusal)
          return response.status(403).json(narrowed.refusal);
        updates = narrowed.updates;

        const result = await SystemSettings.updateSettings(updates);
        const status = result.success
          ? 200
          : ["unknown_keys", "protected_keys"].includes(result.code)
            ? 400
            : 500;
        response.status(status).json(result);
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
        // PR-4d (#35): the preset is only a starting point. When the caller named no
        // scopes it is narrowed to what this creator actually holds (`trimToCeiling`);
        // when they named them, an over-reach is refused rather than quietly trimmed,
        // because someone who asked for a scope deserves an answer about it.
        const named = Array.isArray(scopes) && scopes.length;
        const { apiKey, error } = await ApiKey.create(user.id, name, {
          scopes: named ? scopes : [...ADMIN_DEFAULT_SCOPES],
          trimToCeiling: !named,
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
