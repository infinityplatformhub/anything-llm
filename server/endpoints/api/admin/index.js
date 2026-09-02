const { scopeFor } = require("../../../utils/apiKeySecurity/scopes");
const { emitAuditEvent } = require("../../../utils/events");
const { Invite } = require("../../../models/invite");
const { SystemSettings } = require("../../../models/systemSettings");
const { User, revokeCredentialsFor } = require("../../../models/user");
const { Workspace } = require("../../../models/workspace");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const { WorkspaceUser } = require("../../../models/workspaceUsers");
const { canModifyAdmin } = require("../../../utils/helpers/admin");
const { multiUserMode, reqBody } = require("../../../utils/http");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const {
  offboardUser,
} = require("../../../utils/authorization/policyRepository");
const {
  resolveActor,
} = require("../../../utils/authorization/actorResolver");
const {
  AuthorizationContractError,
} = require("../../../utils/authorization/errors");
const prisma = require("../../../utils/prisma");

function apiAdminEndpoints(app) {
  if (!app) return;

  app.get(
    "/v1/admin/is-multi-user-mode",
    [validApiKey(scopeFor("GET", "/v1/admin/is-multi-user-mode"))],
    (_, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Check to see if the instance is in multi-user-mode first. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
             "isMultiUser": true
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      const isMultiUser = multiUserMode(response);
      response.status(200).json({ isMultiUser });
    }
  );

  app.get(
    "/v1/admin/users",
    [validApiKey(scopeFor("GET", "/v1/admin/users"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Check to see if the instance is in multi-user-mode first. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
             "users": [
                {
                  username: "sample-sam",
                  role: 'default',
                }
             ]
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const users = await User.where();
        response.status(200).json({ users });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/users/new",
    [validApiKey(scopeFor("POST", "/v1/admin/users/new"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Create a new user with username and password. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Key pair object that will define the new user to add to the system.',
        required: true,
        content: {
          "application/json": {
            example: {
              username: "sample-sam",
              password: 'hunter2',
              role: 'default | admin'
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              user: {
                id: 1,
                username: 'sample-sam',
                role: 'default',
              },
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const newUserParams = reqBody(request);
        const { user: newUser, error } = await User.create(newUserParams);
        response.status(newUser ? 200 : 400).json({ user: newUser, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/users/:id",
    [validApiKey(scopeFor("POST", "/v1/admin/users/:id"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.parameters['id'] = {
      in: 'path',
      description: 'id of the user in the database.',
      required: true,
      type: 'string'
    }
    #swagger.description = 'Update existing user settings. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Key pair object that will update the found user. All fields are optional and will not update unless specified.',
        required: true,
        content: {
          "application/json": {
            example: {
              username: "sample-sam",
              password: 'hunter2',
              role: 'default | admin',
              suspended: 0,
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const { id } = request.params;
        const updates = reqBody(request);
        const user = await User.get({ id: Number(id) });
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
    "/v1/admin/users/:id",
    [validApiKey(scopeFor("DELETE", "/v1/admin/users/:id"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Delete existing user by id. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.parameters['id'] = {
      in: 'path',
      description: 'id of the user in the database.',
      required: true,
      type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const { id } = request.params;
        const user = await User.get({ id: Number(id) });
        // #135: this site resolves its OWN actor rather than sharing the session
        // route's. `validApiKey` sets `locals.apiKeyContext`, not `locals.actor`, so
        // there is no user principal here — `resolveActor` turns the key context into
        // the creator's principal, narrowed by the key's scopes, with the `api-key:` id
        // kept as audit provenance.
        const actor = await resolveActor(request, response);
        // One transaction with the delete: a crash between the two would leave the
        // account gone and its grants behind, which is the orphan this issue closes
        // arriving through a narrower window.
        await prisma.$transaction(async (tx) => {
          await offboardUser({ actor, userId: user.id, db: tx });
          await revokeCredentialsFor(user.id, tx);
          await tx.users.delete({ where: { id: user.id } });
        });
        await emitAuditEvent("api_user_deleted", {
          userName: user.username,
        });
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        // #135, BEHAVIOUR CHANGE: a key whose creator lacks `role.revoke` could delete
        // a user yesterday and cannot today. The permission was always wrong for an
        // operation that removes grants. No seeded role holds `user.manage` without
        // `role.revoke`, so default deployments are unaffected.
        //
        // 403 naming the permission, never a bare 500: the transaction rolled back, so
        // the user and their grants are intact and the message should say why.
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

  app.get(
    "/v1/admin/invites",
    [validApiKey(scopeFor("GET", "/v1/admin/invites"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'List all existing invitations to instance regardless of status. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
             "invites": [
                {
                  id: 1,
                  status: "pending",
                  code: 'abc-123',
                  claimedBy: null
                }
             ]
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const invites = await Invite.whereWithUsers();
        response.status(200).json({ invites });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/invite/new",
    [validApiKey(scopeFor("POST", "/v1/admin/invite/new"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Create a new invite code for someone to use to register with instance. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Request body for creation parameters of the invitation',
        required: false,
        content: {
          "application/json": {
            example: {
              workspaceIds: [1,2,45],
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              invite: {
                id: 1,
                status: "pending",
                code: 'abc-123',
              },
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const body = reqBody(request);

        // S11a (#80), ruling D: this route does NOT mail invites, and says so
        // rather than ignoring the field.
        //
        // Mailing requires `user.manage`, and the API-key scope vocabulary has no
        // such scope — it stops at `user.read` and `user.write`. So a key cannot
        // demonstrate the permission the rule demands, and there is no honest way
        // to gate it here. Silently dropping the address would be worse than
        // refusing: the caller would get a 200 and reasonably believe someone was
        // invited when nothing was sent and nobody is coming.
        if (
          body?.email !== undefined &&
          body?.email !== null &&
          body?.email !== ""
        )
          return response.status(400).json({
            invite: null,
            error:
              "This endpoint creates invite links only. Sending an invitation by email requires user management permission, which an API key cannot hold; use the admin UI.",
          });

        const { invite, error } = await Invite.create({
          workspaceIds: body?.workspaceIds ?? [],
        });

        // #71: this route created invites with NO audit record at all — the UI
        // route emitted one, this one did not, so an invite minted through the API
        // left no trace of who could now join the instance. `api_` prefix and no
        // userId, matching `api_user_deleted` above: the actor is an API key, and
        // claiming a user id it does not have would be worse than recording none.
        //
        // The invite's ID, never its CODE — see the note in endpoints/admin.js.
        if (invite)
          await emitAuditEvent("api_invite_created", { inviteId: invite.id });

        response.status(200).json({ invite, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/v1/admin/invite/:id",
    [validApiKey(scopeFor("DELETE", "/v1/admin/invite/:id"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Deactivates (soft-delete) invite by id. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.parameters['id'] = {
      in: 'path',
      description: 'id of the invite in the database.',
      required: true,
      type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const { id } = request.params;
        const parsedId = Number(id);
        if (isNaN(parsedId)) {
          response
            .status(400)
            .json({ success: false, error: "Invalid invite id" });
          return;
        }

        const { success, error } = await Invite.deactivate(parsedId);
        if (!success) {
          response.status(404).json({
            success: false,
            error: "Invite not found or already disabled",
          });
          return;
        }

        response.status(200).json({ success, error });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/admin/workspaces/:workspaceId/users",
    [
      validApiKey(scopeFor("GET", "/v1/admin/workspaces/:workspaceId/users"), {
        workspaceParam: "workspaceId",
      }),
    ],
    async (request, response) => {
      /*
      #swagger.tags = ['Admin']
      #swagger.parameters['workspaceId'] = {
        in: 'path',
        description: 'id of the workspace.',
        required: true,
        type: 'string'
      }
      #swagger.description = 'Retrieve a list of users with permissions to access the specified workspace.'
      #swagger.responses[200] = {
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                users: [
                  {"userId": 1, "role": "admin"},
                  {"userId": 2, "role": "member"}
                ]
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
       #swagger.responses[401] = {
        description: "Instance is not in Multi-User mode. Method denied",
      }
      */

      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const workspaceId = request.params.workspaceId;
        const users = await Workspace.workspaceUsers(workspaceId);

        response.status(200).json({ users });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/workspaces/:workspaceId/update-users",
    [
      validApiKey(
        scopeFor("POST", "/v1/admin/workspaces/:workspaceId/update-users"),
        { workspaceParam: "workspaceId" }
      ),
    ],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.deprecated = true
    #swagger.parameters['workspaceId'] = {
      in: 'path',
      description: 'id of the workspace in the database.',
      required: true,
      type: 'string'
    }
    #swagger.description = 'Overwrite workspace permissions to only be accessible by the given user ids and admins. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Entire array of user ids who can access the workspace. All fields are optional and will not update unless specified.',
        required: true,
        content: {
          "application/json": {
            example: {
              userIds: [1,2,4,12],
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

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

  app.post(
    "/v1/admin/workspaces/:workspaceSlug/manage-users",
    [
      validApiKey(
        scopeFor("POST", "/v1/admin/workspaces/:workspaceSlug/manage-users"),
        { workspaceSlugParam: "workspaceSlug" }
      ),
    ],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.parameters['workspaceSlug'] = {
      in: 'path',
      description: 'slug of the workspace in the database',
      required: true,
      type: 'string'
    }
    #swagger.description = 'Set workspace permissions to be accessible by the given user ids and admins. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Array of user ids who will be given access to the target workspace. <code>reset</code> will remove all existing users from the workspace and only add the new users - default <code>false</code>.',
        required: true,
        content: {
          "application/json": {
            example: {
              userIds: [1,2,4,12],
              reset: false
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
              users: [
                {"userId": 1, "username": "main-admin", "role": "admin"},
                {"userId": 2, "username": "sample-sam", "role": "default"}
              ]
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const { workspaceSlug } = request.params;
        const { userIds: _uids, reset = false } = reqBody(request);
        const userIds = (
          await User.where({ id: { in: _uids.map(Number) } })
        ).map((user) => user.id);
        const workspace = await Workspace.get({ slug: String(workspaceSlug) });
        const workspaceUsers = await Workspace.workspaceUsers(workspace.id);

        if (!workspace) {
          response.status(404).json({
            success: false,
            error: `Workspace ${workspaceSlug} not found`,
            users: workspaceUsers,
          });
          return;
        }

        if (userIds.length === 0) {
          response.status(404).json({
            success: false,
            error: `No valid user IDs provided.`,
            users: workspaceUsers,
          });
          return;
        }

        // Reset all users in the workspace and add the new users as the only users in the workspace
        if (reset) {
          const { success, error } = await Workspace.updateUsers(
            workspace.id,
            userIds
          );
          return response.status(200).json({
            success,
            error,
            users: await Workspace.workspaceUsers(workspace.id),
          });
        }

        // Add new users to the workspace if they are not already in the workspace
        const existingUserIds = workspaceUsers.map((user) => user.userId);
        const usersToAdd = userIds.filter(
          (userId) => !existingUserIds.includes(userId)
        );
        if (usersToAdd.length > 0)
          await WorkspaceUser.createManyUsers(usersToAdd, workspace.id);
        response.status(200).json({
          success: true,
          error: null,
          users: await Workspace.workspaceUsers(workspace.id),
        });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/workspace-chats",
    [validApiKey(scopeFor("POST", "/v1/admin/workspace-chats"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'All chats in the system ordered by most recent. Methods are disabled until multi user mode is enabled via the UI.'
    #swagger.requestBody = {
        description: 'Page offset to show of workspace chats. All fields are optional and will not update unless specified.',
        required: false,
        content: {
          "application/json": {
            example: {
              offset: 2,
            }
          }
        }
      }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const pgSize = 20;
        const { offset = 0 } = reqBody(request);
        const chats = await WorkspaceChats.whereWithData(
          {},
          pgSize,
          offset * pgSize,
          { id: "desc" }
        );

        const hasPages = (await WorkspaceChats.count()) > (offset + 1) * pgSize;
        response.status(200).json({ chats: chats, hasPages });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/admin/preferences",
    [validApiKey(scopeFor("POST", "/v1/admin/preferences"))],
    async (request, response) => {
      /*
    #swagger.tags = ['Admin']
    #swagger.description = 'Update multi-user preferences for instance. Methods are disabled until multi user mode is enabled via the UI. Breaking behavior: unknown or protected keys reject the entire request with 400. Readable settings max_embed_chunk_size, imported_agent_skills, and feature_flags are not writable; multi_user_mode and onboarding_complete are protected.'
    #swagger.requestBody = {
      description: 'Object with setting key and new value to set. All keys are optional and will not update unless specified.',
      required: true,
      content: {
        "application/json": {
          example: {
            support_email: "support@example.com",
          }
        }
      }
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              success: true,
              error: null,
            }
          }
        }
      }
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
     #swagger.responses[401] = {
      description: "Instance is not in Multi-User mode. Method denied",
    }
    */
      try {
        if (!multiUserMode(response)) {
          response.sendStatus(401).end();
          return;
        }

        const updates = reqBody(request);
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
}

module.exports = { apiAdminEndpoints };
