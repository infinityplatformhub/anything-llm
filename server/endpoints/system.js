process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();
const {
  normalizePath,
  isWithin,
  listFolders,
  getDocumentsByFolder,
  searchDocuments,
  getDocumentsByDocPaths,
} = require("../utils/files");
const { purgeDocument, purgeFolder } = require("../utils/files/purgeDocument");
const { getVectorDbClass } = require("../utils/helpers");
const {
  updateENV,
  dumpENV,
  clearStoredCredential,
} = require("../utils/helpers/updateENV");
const {
  reqBody,
  makeJWT,
  userFromSession,
  multiUserMode,
  queryParams,
} = require("../utils/http");
const {
  narrowManagerSystemPreferences,
} = require("../utils/managerSystemPreferences");
const {
  loginAccountRateLimit,
  loginIpRateLimit,
} = require("../utils/middleware/requestControls");
const {
  handleAssetUpload,
  handlePfpUpload,
  handleAudioUpload,
} = require("../utils/files/multer");
const { v4 } = require("uuid");
const { SystemSettings } = require("../models/systemSettings");
const { User } = require("../models/user");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const {
  requireSelfSession,
} = require("../utils/middleware/requireSelfSession");
const { requirePermission } = require("../utils/middleware/requirePermission");
const { resolveActor } = require("../utils/authorization/actorResolver");
const {
  DatabaseAuthorizationEngine,
} = require("../utils/authorization/engine");
const { orgResource } = require("../utils/middleware/resourceResolvers");
const fs = require("fs");
const path = require("path");
const {
  getDefaultFilename,
  determineLogoFilepath,
  fetchLogo,
  validFilename,
  renameLogoFile,
  removeCustomLogo,
  LOGO_FILENAME,
  isDefaultFilename,
} = require("../utils/files/logo");
const { Telemetry } = require("../models/telemetry");
const { EventLogs } = require("../models/eventLogs");
const { ApiKey } = require("../models/apiKeys");
const { SINGLE_USER_KEY_SCOPES } = require("../utils/apiKeySecurity/scopes");
const { getCustomModels } = require("../utils/helpers/customModels");
const { WorkspaceChats } = require("../models/workspaceChats");
const { WorkspaceThread } = require("../models/workspaceThread");
const { WorkspaceParsedFiles } = require("../models/workspaceParsedFiles");
const { isMultiUserSetup } = require("../utils/middleware/deploymentMode");
const { fetchPfp, determinePfpFilepath } = require("../utils/files/pfp");
const { exportChatsAsType } = require("../utils/helpers/chat/convertTo");
const { emitAuditEvent } = require("../utils/events");
const { CollectorApi } = require("../utils/collectorApi");
const {
  recoverAccount,
  resetPassword,
  generateRecoveryCodes,
} = require("../utils/PasswordRecovery");
const { SlashCommandPresets } = require("../models/slashCommandsPresets");
const { EncryptionManager } = require("../utils/EncryptionManager");
const { BrowserExtensionApiKey } = require("../models/browserExtensionApiKey");
const { MobileDevice } = require("../models/mobileDevice");
const {
  simpleSSOLoginDisabled,
} = require("../utils/middleware/simpleSSOEnabled");
const { TemporaryAuthToken } = require("../models/temporaryAuthToken");
const { SystemPromptVariables } = require("../models/systemPromptVariables");
const { isReservedCommand } = require("../utils/chats");
const { AgentSkillWhitelist } = require("../models/agentSkillWhitelist");
const { Memory } = require("../models/memory");

// UI capability lists stay short and explicit rather than exposing every seeded
// action. ACTION_SCOPES validates actions with a restricted resource scope; it is
// not a catalog (today it contains only `org.member`), so these lists cannot be
// generated from it.
//
// #53: `org.member` is deliberately ABSENT from ORG_CAPABILITIES. Every
// principal of the org holds it, so there is nothing for a UI to show or hide on
// it — a capability everyone has gates nothing. Asking it outside the org scope
// is also a contract error, not a false result.
const ORG_CAPABILITIES = [
  "chat.read_others",
  "document.bulk_export",
  "user.manage",
  "settings.write",
  "key.manage",
  "access.diagnose",
  // Creating a workspace has no existing workspace to authorize against. Both
  // workspaces.js and admin.js therefore gate it against `orgResource`.
  "workspace.create",
];

// Workspace capabilities are separate because the endpoint can ask these about
// one workspace without mixing resource scopes into the org authorization batch.
const WORKSPACE_CAPABILITIES = [
  "workspace.read",
  "workspace.write",
  "workspace.delete",
  "workspace.members.manage",
  "document.create",
  "document.delete",
  "chat.send",
];

/**
 * #40 task 2: the workspace half of /system/my-capabilities.
 *
 * Answers null for every workspace this caller cannot see — whether it does not
 * exist or belongs to someone else. Those two are not separate branches here:
 * `Workspace.getWithUser` filters on `workspace_users.some.user_id`, so both
 * fall out of the SAME query as "no row". Existence therefore cannot leak ahead
 * of membership by construction rather than by remembering to hide it (#41
 * /v1/document has the same shape).
 *
 * Returns null rather than throwing, and never re-throws: the caller's org half
 * is already computed by the time this runs, and losing it to a workspace-half
 * failure is the exact bug this split exists to prevent.
 */
async function workspaceCapabilities({ actor, engine, user, workspaceId }) {
  try {
    // QA-1 F5: express parses `?workspaceId[]=1` into an array and
    // `?workspaceId[x]=1` into an object, and `Number([1])` is 1 — so a
    // non-string reaches the lookup carrying a value the caller never wrote as
    // a scalar. Require a string before anything else looks at it.
    if (typeof workspaceId !== "string") return null;

    // A non-numeric id never reaches the database. `Number("")` is 0 and
    // `Number("1.5")` is 1.5 — both would otherwise become a lookup for
    // something the caller did not ask about.
    const id = Number(workspaceId);
    if (!Number.isInteger(id) || id <= 0) return null;

    // TL-1 F2: `getWithUser` fails OPEN for a caller with no user id. Prisma
    // drops undefined keys, so `some: {user_id: undefined}` becomes `some: {}`
    // — "has at least one member" — which matches every populated workspace,
    // including ones this caller has nothing to do with. Verified against
    // postgres, not reasoned about: a non-member id matches nothing, undefined
    // matches the workspace.
    //
    // So the guard is load-bearing, not defence in depth. It keys on the actor
    // TYPE rather than on the presence of a user id, and runs before any
    // lookup: resolveActor answers `service` (api key, single-user) and `embed`
    // as well as `user`, and only `user` has an identity `workspace_users` can
    // be filtered by.
    //
    // Deliberately NOT keyed on grantPrincipal: an api key carries its
    // creator's principal, so a grantPrincipal check would answer with the
    // CREATOR's memberships for a caller holding only the key. Answering
    // properly for a key means grants(createdBy) ∩ scopes(key), which is the
    // #29 scope ceiling — issue #103, not this one.
    if (actor?.type !== "user" || !user?.id) return null;

    const { Workspace } = require("../models/workspace");
    const workspace = await Workspace.getWithUser(user, { id });
    if (!workspace) return null;

    // QA-1 F3: the org this is decided under comes from the ACTOR, not from a
    // literal. `workspaces` carries no orgId column today (verified against
    // prisma/schema.prisma), so the row cannot supply one, and the engine reads
    // `actor.orgId` for the grant lookup either way (engine.js:176) — a literal
    // here would disagree with the engine the moment a second org exists.
    // Residual: with no orgId on the row, nothing ties THIS workspace to that
    // org, so cross-tenant separation still rests on membership alone. Closing
    // that needs the column, which is a schema change and not this issue.
    const resource = {
      type: "workspace",
      id: String(workspace.id),
      orgId: actor?.orgId ?? 1,
      workspaceId: workspace.id,
    };
    const decisions = await Promise.all(
      WORKSPACE_CAPABILITIES.map(async (action) => {
        const result = await engine.authorizeMany({
          actor,
          action,
          resources: [resource],
        });
        return [action, result.get(0)?.allowed === true];
      })
    );
    return {
      id: workspace.id,
      capabilities: Object.fromEntries(decisions),
    };
  } catch (e) {
    console.error(e.message, e);
    // Fail closed, and identically to "cannot see it": a workspace whose
    // capabilities we cannot compute offers nothing.
    return null;
  }
}

function systemEndpoints(app) {
  if (!app) return;

  app.get("/ping", (_, response) => {
    response.status(200).json({ online: true });
  });

  // O5a (#90): Prometheus scrape target.
  //
  // Unauthenticated and mounted inside /api, like /ping, so it inherits
  // `ipAllowlist` (index.js:102) — a scraper reaches it by being on the
  // allowlist rather than by holding a key. A separate port would double what
  // the operator has to firewall and would not compose with the allowlist they
  // already configured.
  //
  // Read this before assuming it is protected: an EMPTY `IP_ALLOWLIST` means
  // allow-everything (utils/middleware/requestControls.js:223), and empty is
  // the default. On an internet-facing box this route is public. Metrics hold
  // no secrets, but they are an inventory — user counts, workspace counts,
  // error rates — and an inventory is reconnaissance. The doctor (#74) warns
  // about exactly this combination.
  //
  // Labels never carry user-supplied text; see utils/metrics for why that is
  // enforced rather than agreed.
  app.get("/metrics", async (_, response) => {
    try {
      const { render } = require("../utils/metrics");
      const { contentType, body } = await render();
      response.setHeader("Content-Type", contentType);
      response.status(200).send(body);
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/migrate", async (_, response) => {
    response.sendStatus(200);
  });

  app.get(
    "/env-dump",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (_, response) => {
      if (process.env.NODE_ENV !== "production")
        return response.sendStatus(200).end();
      dumpENV();
      response.sendStatus(200).end();
    }
  );

  app.get("/onboarding", async (_, response) => {
    try {
      const results = await SystemSettings.isOnboardingComplete();
      response.status(200).json({ onboardingComplete: results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  // #52: writes `onboarding_complete` into system_settings, so it is
  // settings.write like every other route that touches that table. It carried
  // session auth alone, which meant nothing asked the engine and an
  // impersonated session could mark onboarding complete.
  app.post(
    "/onboarding",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (_, response) => {
      try {
        await SystemSettings.markOnboardingComplete();
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/setup-complete", async (_, response) => {
    try {
      const results = await SystemSettings.currentSettings();
      response.status(200).json({ results });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get(
    "/system/check-token",
    [validatedRequest],
    async (request, response) => {
      try {
        if (multiUserMode(response)) {
          const user = await userFromSession(request, response);
          if (!user || user.suspended) {
            response.sendStatus(403).end();
            return;
          }

          response.sendStatus(200).end();
          return;
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Refreshes the user object from the session from a provided token.
   * This does not refresh the token itself - if that is expired or invalid, the user will be logged out.
   * This simply keeps the user object in sync with the database over the course of the session.
   * @returns {Promise<{success: boolean, user: Object | null, message: string | null}>}
   */
  app.get(
    "/system/refresh-user",
    [validatedRequest],
    async (request, response) => {
      try {
        if (!multiUserMode(response))
          return response
            .status(200)
            .json({ success: true, user: null, message: null });

        const user = await userFromSession(request, response);
        if (!user)
          return response.status(200).json({
            success: false,
            user: null,
            message: "Session expired or invalid.",
          });

        if (user.suspended)
          return response.status(200).json({
            success: false,
            user: null,
            message: "User is suspended.",
          });

        return response.status(200).json({
          success: true,
          user: User.filterFields(user),
          message: null,
        });
      } catch (e) {
        return response.status(500).json({
          success: false,
          user: null,
          message: e.message,
        });
      }
    }
  );

  app.post(
    "/request-token",
    [loginIpRateLimit, loginAccountRateLimit],
    async (request, response) => {
      // O5a-wire (#102): counted ONCE, on the way out, from the status code —
      // not at each branch. This handler has TEN outcome branches across the
      // multi-user and single-user paths (three that issue a token, seven that
      // refuse), and a branch added later would be counted nowhere if each site
      // had to remember. The status code is the thing every branch already sets
      // and cannot forget.
      //
      // The label is a CONSTANT either way. Nothing from the request — not the
      // username, not the IP, not which branch refused — reaches a label:
      // `outcome` allows exactly "success" and "failure", so a call site
      // attempting otherwise throws (utils/metrics).
      const { safeObserve } = require("../utils/metrics");
      response.on("finish", () =>
        safeObserve("auth_attempts_total", {
          outcome: response.statusCode === 200 ? "success" : "failure",
        })
      );

      try {
        const bcrypt = require("bcryptjs");

        if (await SystemSettings.isMultiUserMode()) {
          if (simpleSSOLoginDisabled()) {
            response.status(403).json({
              user: null,
              valid: false,
              token: null,
              message:
                "[005] Login via credentials has been disabled by the administrator.",
            });
            return;
          }

          const { username, password } = reqBody(request);
          const existingUser = await User._get({ username: String(username) });

          if (!existingUser) {
            await emitAuditEvent(
              "failed_login_invalid_username",
              {
                ip: request.ip || "Unknown IP",
                username: username || "Unknown user",
              },
              existingUser?.id
            );
            response.status(401).json({
              user: null,
              valid: false,
              token: null,
              message: "Invalid login credentials.",
            });
            return;
          }

          if (!bcrypt.compareSync(String(password), existingUser.password)) {
            await emitAuditEvent(
              "failed_login_invalid_password",
              {
                ip: request.ip || "Unknown IP",
                username: username || "Unknown user",
              },
              existingUser?.id
            );
            response.status(401).json({
              user: null,
              valid: false,
              token: null,
              message: "Invalid login credentials.",
            });
            return;
          }

          if (existingUser.suspended) {
            await emitAuditEvent(
              "failed_login_account_suspended",
              {
                ip: request.ip || "Unknown IP",
                username: username || "Unknown user",
              },
              existingUser?.id
            );
            response.status(401).json({
              user: null,
              valid: false,
              token: null,
              message: "Invalid login credentials.",
            });
            return;
          }

          await Telemetry.sendTelemetry(
            "login_event",
            { multiUserMode: false },
            existingUser?.id
          );

          await emitAuditEvent(
            "login_event",
            {
              ip: request.ip || "Unknown IP",
              username: existingUser.username || "Unknown user",
            },
            existingUser?.id
          );

          // Generate a session token for the user then check if they have seen the recovery codes
          // and if not, generate recovery codes and return them to the frontend.
          const sessionToken = makeJWT(
            { id: existingUser.id, username: existingUser.username },
            process.env.JWT_EXPIRY
          );
          if (!existingUser.seen_recovery_codes) {
            const plainTextCodes = await generateRecoveryCodes(existingUser.id);
            response.status(200).json({
              valid: true,
              user: User.filterFields(existingUser),
              token: sessionToken,
              message: null,
              recoveryCodes: plainTextCodes,
            });
            return;
          }

          response.status(200).json({
            valid: true,
            user: User.filterFields(existingUser),
            token: sessionToken,
            message: null,
          });
          return;
        } else {
          // issue 58 (ruling C): the boot repair cannot cover shape (b) that
          // ARISES while the server is running — a restore into a live
          // instance, or a settings row edited by hand. This branch
          // authenticates against AUTH_TOKEN rather than any user account, so
          // taking it on an instance that HAS accounts hands out a session
          // nobody's credentials were checked for. User rows present means the
          // instance is multi-user, whatever the setting currently says.
          if ((await User.count()) > 0) {
            await emitAuditEvent("failed_login_invalid_password", {
              ip: request.ip || "Unknown IP",
              multiUserMode: false,
            });
            // The ordinary invalid-password answer: which branch refused is not
            // something an unauthenticated caller gets to learn.
            response.status(401).json({
              valid: false,
              token: null,
              message: "[003] Invalid password provided",
            });
            return;
          }

          const { password } = reqBody(request);
          // #48 NIT-3 / #59 M10: `bcrypt.compareSync` throws when either argument is not
          // a string, so BOTH an instance with no AUTH_TOKEN and a request that omits
          // `password` answered 500 to a login attempt — an error shape that says
          // "something broke here", which is more than a caller should learn from a
          // failed login, and which is not even true: nothing broke, there is nothing to
          // match. The missing-field half fires whether or not AUTH_TOKEN is set.
          // Same 401 and same `[003]` body as a wrong password, so the three cases are
          // indistinguishable to the caller.
          if (!process.env.AUTH_TOKEN || typeof password !== "string") {
            await emitAuditEvent("failed_login_invalid_password", {
              ip: request.ip || "Unknown IP",
              multiUserMode: false,
            });
            response.status(401).json({
              valid: false,
              token: null,
              message: "[003] Invalid password provided",
            });
            return;
          }
          if (
            !bcrypt.compareSync(
              password,
              bcrypt.hashSync(process.env.AUTH_TOKEN, 10)
            )
          ) {
            await emitAuditEvent("failed_login_invalid_password", {
              ip: request.ip || "Unknown IP",
              multiUserMode: false,
            });
            response.status(401).json({
              valid: false,
              token: null,
              message: "[003] Invalid password provided",
            });
            return;
          }

          await Telemetry.sendTelemetry("login_event", {
            multiUserMode: false,
          });
          await emitAuditEvent("login_event", {
            ip: request.ip || "Unknown IP",
            multiUserMode: false,
          });
          response.status(200).json({
            valid: true,
            token: makeJWT(
              { p: new EncryptionManager().encrypt(password) },
              process.env.JWT_EXPIRY
            ),
            message: null,
          });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );


  app.post(
    "/system/recover-account",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { username, recoveryCodes } = reqBody(request);
        const { success, resetToken, error } = await recoverAccount(
          username,
          recoveryCodes
        );

        if (success) {
          response.status(200).json({ success, resetToken });
        } else {
          response.status(400).json({ success, message: error });
        }
      } catch (error) {
        console.error("Error recovering account:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/reset-password",
    [isMultiUserSetup],
    async (request, response) => {
      try {
        const { token, newPassword, confirmPassword } = reqBody(request);
        const { success, message, error } = await resetPassword(
          token,
          newPassword,
          confirmPassword
        );

        if (success) {
          response.status(200).json({ success, message });
        } else {
          response.status(400).json({ success, error });
        }
      } catch (error) {
        console.error("Error resetting password:", error);
        response.status(500).json({ success: false, message: error.message });
      }
    }
  );

  app.get(
    "/system/system-vectors",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (request, response) => {
      try {
        const query = queryParams(request);
        const VectorDb = getVectorDbClass();
        // T-5 (#30) slice 3 (S-25): this took `system.read` at ORG scope and then answered
        // a WORKSPACE-scoped question with no check that the slug was in the actor's
        // scope — the resource came from the request while the permission came from
        // somewhere else. Structurally the same mistake slice 2 round 3 fixed in
        // `pinnedDocs`, and with the same consequence: `?slug=` counted any workspace on
        // the instance, and omitting it counted all of them.
        //
        // Out of scope answers 404, identical to a workspace that does not exist. A 403
        // would confirm it exists, which is the oracle in a different costume.
        const {
          scopedNamespaceCount,
          scopedTotalVectors,
          CardinalityScopeTooLargeError,
        } = require("../utils/authorization/cardinality");
        const {
          retrievalFilterFor,
        } = require("../utils/authorization/retrievalFilter");
        const { Workspace } = require("../models/workspace");

        const aclFilter = await retrievalFilterFor({
          actor: response.locals.actor,
          action: "document.read",
        });

        let vectorCount;
        try {
          if (query.slug) {
            const counted = await scopedNamespaceCount({
              VectorDb,
              slug: String(query.slug),
              aclFilter,
              resolveSlug: async (slug) => Workspace.get({ slug }),
            });
            if (counted === null) return response.sendStatus(404);
            vectorCount = counted;
          } else {
            ({ vectorCount } = await scopedTotalVectors({
              VectorDb,
              aclFilter,
              countFor: async (workspaceId) => {
                const workspace = await Workspace.get({
                  id: Number(workspaceId),
                });
                if (!workspace) return 0;
                return VectorDb.namespaceCount(workspace.slug);
              },
            }));
          }
        } catch (error) {
          if (error instanceof CardinalityScopeTooLargeError) {
            console.error("[cardinality]", error.message);
            return response
              .status(500)
              .json({ error: "workspace scope too large to count" });
          }
          throw error;
        }
        response.status(200).json({ vectorCount });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-document",
    [validatedRequest, requirePermission("document.delete", orgResource)],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-documents",
    [validatedRequest, requirePermission("document.delete", orgResource)],
    async (request, response) => {
      try {
        const { names } = reqBody(request);
        for await (const name of names) await purgeDocument(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/remove-folder",
    [
      validatedRequest,
      requirePermission("document.folder.manage", orgResource),
    ],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        await purgeFolder(name);
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/local-files",
    [validatedRequest, requirePermission("document.read", orgResource)],
    async (request, response) => {
      try {
        const { folder, offset, limit } = queryParams(request);
        if (folder) {
          // Passed through as-is: getDocumentsByFolder clamps the window and
          // understands `limit=all`.
          const result = await getDocumentsByFolder(folder, { offset, limit });
          response.status(result.code).json(result);
        } else {
          const localFiles = listFolders();
          response.status(200).json({ localFiles });
        }
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/local-files/search",
    [validatedRequest, requirePermission("document.search", orgResource)],
    async (request, response) => {
      try {
        const { q } = queryParams(request);
        const results = await searchDocuments(q);
        response.status(200).json({ results });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/local-files/by-docpaths",
    [validatedRequest, requirePermission("document.read", orgResource)],
    async (request, response) => {
      try {
        const { docpaths = [] } = reqBody(request);
        const documents = await getDocumentsByDocPaths(docpaths);
        response.status(200).json({ documents });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/document-processing-status",
    [validatedRequest],
    async (_, response) => {
      try {
        const online = await new CollectorApi().online();
        response.sendStatus(online ? 200 : 503);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/system/accepted-document-types",
    [validatedRequest],
    async (_, response) => {
      try {
        const types = await new CollectorApi().acceptedFileTypes();
        if (!types) {
          response.sendStatus(404).end();
          return;
        }

        response.status(200).json({ types });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // #48: the only way to take a stored credential back. `POST /system/update-env` with an
  // empty value cannot do it — 49 of the 91 credential keys carry a validator that
  // rejects "" before the delete branch is reached, and `force` does not bypass those
  // validators. A separate route rather than a sentinel value in the update payload:
  // the update path is shared by all 213 settings, and a magic value there would be one
  // typo away from clearing a credential nobody meant to touch.
  // issue 84: `system.write`, matching the update route above. Clearing a credential
  // is the same authority as writing one -- an actor who may not set OPEN_AI_KEY has
  // no business revoking it, and `INSTANCE_AUTH_KEYS` blocks only AUTH_TOKEN and
  // JWT_SECRET of the 92 secret keys, leaving 90 clearable under the weaker gate.
  app.delete(
    "/system/credential/:envKey",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const { envKey } = request.params;
        const { cleared, error } = await clearStoredCredential(envKey);
        if (!cleared) return response.status(400).json({ cleared, error });

        await emitAuditEvent(
          "credential_cleared",
          // The key name only. The value is the thing being revoked, and an audit row
          // holding it would outlive the credential it was written to retire.
          { envKey },
          response?.locals?.user?.id
        );
        return response.status(200).json({ cleared: true, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-env",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const body = reqBody(request);
        const result = await updateENV(
          body,
          false,
          response?.locals?.user?.id
        );
        const status = result.code === "unknown_keys" ? 400 : result.error ? 500 : 200;
        response.status(status).json(result);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/update-password",
    [validatedRequest],
    async (request, response) => {
      try {
        // Cannot update password in multi - user mode.
        if (multiUserMode(response)) {
          response.status(401).json({ error: "Single-user mode required." });
          return;
        }

        let error = null;
        const { usePassword, newPassword } = reqBody(request);
        if (!usePassword) {
          // Password is being disabled so directly unset everything to bypass validation.
          process.env.AUTH_TOKEN = "";
          process.env.JWT_SECRET = "";
        } else {
          // An all-asterisk value is indistinguishable from the UI's masked
          // placeholder, so updateENV would silently drop it while JWT_SECRET
          // still rotates - reject it before mutating anything.
          if (/^\*+$/.test(String(newPassword))) {
            response.status(200).json({
              success: false,
              error: "Password cannot consist of only asterisks (*).",
            });
            return;
          }
          const update = await updateENV(
            {
              AuthToken: newPassword,
              JWTSecret: v4(),
            },
            true
          );
          error = update?.error;
        }
        response.status(200).json({ success: !error, error });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/enable-multi-user",
    // #52: flipping the instance into multi-user mode creates the first admin.
    // It carried session auth alone; settings.write is what every other route
    // that changes instance configuration asks for.
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          response.status(200).json({
            success: false,
            error: "Multi-user mode is already enabled.",
          });
          return;
        }

        const { username, password } = reqBody(request);
        const { user, error } = await User.create({
          username,
          password,
          role: "admin",
        });

        if (error || !user) {
          response.status(400).json({
            success: false,
            error: error || "Failed to enable multi-user mode.",
          });
          return;
        }

        // #59: `_updateSettings` catches its own errors and RETURNS `{success:false}`.
        // Read as a bare await, a failed write is indistinguishable from a successful
        // one, and everything below proceeds — leaving user rows behind with
        // `multi_user_mode` still false, which is deployment shape (b). Throwing here is
        // what makes the rollback in the catch block run at all.
        const modeUpdate = await SystemSettings._updateSettings({
          multi_user_mode: true,
        });
        if (!modeUpdate.success)
          throw new Error(
            `Failed to enable multi-user mode: ${modeUpdate.error ?? "settings write failed"}`
          );
        await BrowserExtensionApiKey.migrateApiKeysToMultiUser(user.id);
        await Memory.migrateToMultiUser(user.id);
        await WorkspaceChats.migrateToMultiUser(user.id);
        await WorkspaceThread.migrateToMultiUser(user.id);
        await WorkspaceParsedFiles.migrateToMultiUser(user.id);
        await MobileDevice.migrateDevicesToMultiUser(user.id);
        await SlashCommandPresets.migrateToMultiUser(user.id);
        await AgentSkillWhitelist.clearSingleUserWhitelist();
        await updateENV(
          {
            JWTSecret: process.env.JWT_SECRET || v4(),
          },
          true
        );
        await Telemetry.sendTelemetry("enabled_multi_user_mode", {
          multiUserMode: true,
        });
        await emitAuditEvent("multi_user_mode_enabled", {}, user?.id);
        response.status(200).json({ success: !!user, error });
      } catch (e) {
        // #59: the rollback has to check too. The reason we are in this catch is
        // usually that the settings store is failing, which is exactly when this write
        // fails as well — an unchecked rollback reports itself as having run while the
        // instance is left in shape (b): user rows present, multi_user_mode false.
        await User.delete({});
        const rollback = await SystemSettings._updateSettings({
          multi_user_mode: false,
        });
        if (!rollback.success)
          console.error(
            `\x1b[31m[MULTI-USER ROLLBACK FAILED]\x1b[0m ${rollback.error ?? "settings write failed"} — ` +
              "user accounts were removed but multi_user_mode could not be reset. The " +
              "instance is in deployment shape (b); the boot-time repair (#58) corrects " +
              "it on the next restart."
          );

        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get("/system/multi-user-mode", async (_, response) => {
    try {
      const multiUserMode = await SystemSettings.isMultiUserMode();
      response.status(200).json({ multiUserMode });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/system/logo", async function (request, response) {
    try {
      const darkMode = request?.query?.theme !== "light";
      const defaultFilename = getDefaultFilename(darkMode);
      const logoPath = await determineLogoFilepath(defaultFilename);
      const { found, buffer, size, mime } = fetchLogo(logoPath);

      if (!found) {
        response.sendStatus(204).end();
        return;
      }

      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      response.writeHead(200, {
        "Access-Control-Expose-Headers":
          "Content-Disposition,X-Is-Custom-Logo,Content-Type,Content-Length",
        "Content-Type": mime || "image/png",
        "Content-Disposition": `attachment; filename=${path.basename(
          logoPath
        )}`,
        "Content-Length": size,
        "X-Is-Custom-Logo":
          currentLogoFilename !== null &&
          currentLogoFilename !== defaultFilename &&
          !isDefaultFilename(currentLogoFilename),
      });
      response.end(Buffer.from(buffer, "base64"));
      return;
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/footer-data", [validatedRequest], async (_, response) => {
    try {
      const footerData =
        (await SystemSettings.get({ label: "footer_data" }))?.value ??
        JSON.stringify([]);
      response.status(200).json({ footerData: footerData });
    } catch (error) {
      console.error("Error fetching footer data:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get("/system/support-email", [validatedRequest], async (_, response) => {
    try {
      const supportEmail =
        (
          await SystemSettings.get({
            label: "support_email",
          })
        )?.value ?? null;
      response.status(200).json({ supportEmail: supportEmail });
    } catch (error) {
      console.error("Error fetching support email:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  // No middleware protection in order to get this on the login page
  app.get("/system/custom-app-name", async (_, response) => {
    try {
      const customAppName =
        (
          await SystemSettings.get({
            label: "custom_app_name",
          })
        )?.value ?? "ApproofWorkspace";
      response.status(200).json({ customAppName: customAppName });
    } catch (error) {
      console.error("Error fetching custom app name:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/pfp/:id",
    [validatedRequest, requirePermission("user.read", orgResource)],
    async function (request, response) {
      try {
        const { id } = request.params;
        if (response.locals?.user?.id !== Number(id))
          return response.sendStatus(204).end();

        const pfpPath = await determinePfpFilepath(id);
        if (!pfpPath) return response.sendStatus(204).end();

        const { found, buffer, size, mime } = fetchPfp(pfpPath);
        if (!found) return response.sendStatus(204).end();

        response.writeHead(200, {
          "Content-Type": mime || "image/png",
          "Content-Disposition": `attachment; filename=${path.basename(pfpPath)}`,
          "Content-Length": size,
        });
        response.end(Buffer.from(buffer, "base64"));
        return;
      } catch (error) {
        console.error("Error processing the logo request:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-pfp",
    [
      validatedRequest,
      requirePermission("user.write", orgResource),
      handlePfpUpload,
    ],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const uploadedFileName = request.randomFileName;
        if (!uploadedFileName) {
          return response.status(400).json({ message: "File upload failed." });
        }

        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;
        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(userRecord.pfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: uploadedFileName,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture uploaded successfully."
            : error || "Failed to update with new profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture upload:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );
  app.get(
    "/system/default-system-prompt",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (_, response) => {
      try {
        const defaultSystemPrompt = await SystemSettings.get({
          label: "default_system_prompt",
        });

        response.status(200).json({
          success: true,
          defaultSystemPrompt:
            defaultSystemPrompt?.value ||
            SystemSettings.saneDefaultSystemPrompt,
          saneDefaultSystemPrompt: SystemSettings.saneDefaultSystemPrompt,
        });
      } catch (error) {
        console.error("Error fetching default system prompt:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/default-system-prompt",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      try {
        const { defaultSystemPrompt } = reqBody(request);
        // #78 then #72: whether this actor may write the key at all is settled
        // before the model is asked whether the key exists.
        const narrowed = await narrowManagerSystemPreferences(
          response.locals.actor,
          { default_system_prompt: defaultSystemPrompt }
        );
        if (narrowed.refusal)
          return response.status(403).json(narrowed.refusal);
        const result = await SystemSettings.updateSettings(narrowed.updates);
        // Defensive and deliberately unreachable today: this route builds its own
        // body from one fixed, supported key, so neither code can occur. It stays
        // so the mapping is uniform across every route that calls updateSettings --
        // the day someone widens this body, the refusal is already wired.
        if (["unknown_keys", "protected_keys"].includes(result.code))
          return response.status(400).json(result);
        if (!result.success)
          throw new Error(
            result.error || "Failed to update default system prompt."
          );
        response.status(200).json({
          success: true,
          message: "Default system prompt updated successfully.",
        });
      } catch (error) {
        console.error("Error updating default system prompt:", error);
        response.status(500).json({
          success: false,
          message: error.message || "Internal server error",
        });
      }
    }
  );

  app.delete(
    "/system/remove-pfp",
    [validatedRequest, requirePermission("user.write", orgResource)],
    async function (request, response) {
      try {
        const user = await userFromSession(request, response);
        const userRecord = await User.get({ id: user.id });
        const oldPfpFilename = userRecord.pfpFilename;

        if (oldPfpFilename) {
          const storagePath = path.join(__dirname, "../storage/assets/pfp");
          const oldPfpPath = path.join(
            storagePath,
            normalizePath(oldPfpFilename)
          );
          if (!isWithin(path.resolve(storagePath), path.resolve(oldPfpPath)))
            throw new Error("Invalid path name");
          if (fs.existsSync(oldPfpPath)) fs.unlinkSync(oldPfpPath);
        }

        const { success, error } = await User.update(user.id, {
          pfpFilename: null,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Profile picture removed successfully."
            : error || "Failed to remove profile picture.",
        });
      } catch (error) {
        console.error("Error processing the profile picture removal:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/upload-logo",
    [
      validatedRequest,
      requirePermission("settings.write", orgResource),
      handleAssetUpload,
    ],
    async (request, response) => {
      if (!request?.file || !request?.file.originalname) {
        return response.status(400).json({ message: "No logo file provided." });
      }

      if (!validFilename(request.file.originalname)) {
        return response.status(400).json({
          message: "Invalid file name. Please choose a different file.",
        });
      }

      try {
        const narrowed = await narrowManagerSystemPreferences(
          response.locals.actor,
          { logo_filename: request.file.originalname }
        );
        if (narrowed.refusal)
          return response.status(403).json(narrowed.refusal);
        const newFilename = await renameLogoFile(request.file.originalname);
        const existingLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(existingLogoFilename);

        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: newFilename,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo uploaded successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo upload:", error);
        response.status(500).json({ message: "Error uploading the logo." });
      }
    }
  );

  app.get("/system/is-default-logo", async (_, response) => {
    try {
      const currentLogoFilename = await SystemSettings.currentLogoFilename();
      const isDefaultLogo =
        !currentLogoFilename || currentLogoFilename === LOGO_FILENAME;
      response.status(200).json({ isDefaultLogo });
    } catch (error) {
      console.error("Error processing the logo request:", error);
      response.status(500).json({ message: "Internal server error" });
    }
  });

  app.get(
    "/system/remove-logo",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (_request, response) => {
      try {
        const narrowed = await narrowManagerSystemPreferences(
          response.locals.actor,
          { logo_filename: LOGO_FILENAME }
        );
        if (narrowed.refusal)
          return response.status(403).json(narrowed.refusal);
        const currentLogoFilename = await SystemSettings.currentLogoFilename();
        await removeCustomLogo(currentLogoFilename);
        const { success, error } = await SystemSettings._updateSettings({
          logo_filename: LOGO_FILENAME,
        });

        return response.status(success ? 200 : 500).json({
          message: success
            ? "Logo removed successfully."
            : error || "Failed to update with new logo.",
        });
      } catch (error) {
        console.error("Error processing the logo removal:", error);
        response.status(500).json({ message: "Error removing the logo." });
      }
    }
  );

  app.get("/system/api-keys", [validatedRequest], async (_, response) => {
    try {
      if (response.locals.multiUserMode) {
        return response.sendStatus(401).end();
      }

      const apiKeys = await ApiKey.where({});
      return response.status(200).json({
        apiKeys,
        error: null,
      });
    } catch (error) {
      console.error(error);
      response.status(500).json({
        apiKey: null,
        error: "Could not find an API Key.",
      });
    }
  });

  app.post(
    "/system/generate-api-key",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode) {
          return response
            .status(401)
            .json({ error: "Single-user mode required." });
        }

        const { name = null, scopes = null } = reqBody(request);
        // Single-user mode: the operator minting this key already administers the
        // deployment, so the preset is their own grant. Still enumerated, never "*".
        // PR-4d (#35): the ceiling reads that operator's grants through the same
        // `keyGrantPrincipal` the request path uses, so the preset narrows if the
        // single-user principal ever holds less than it does today.
        const named = Array.isArray(scopes) && scopes.length;
        const { apiKey, error } = await ApiKey.create(null, name, {
          scopes: named ? scopes : [...SINGLE_USER_KEY_SCOPES],
          trimToCeiling: !named,
        });
        if (error)
          return response.status(400).json({ apiKey: null, error });
        await emitAuditEvent(
          "api_key_created",
          { name: apiKey?.name },
          response?.locals?.user?.id
        );
        return response.status(200).json({
          apiKey,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).json({
          apiKey: null,
          error: "Error generating api key.",
        });
      }
    }
  );

  // TODO: This endpoint is replicated in the admin endpoints file.
  // and should be consolidated to be a single endpoint with flexible role protection.
  app.delete(
    "/system/api-key/:id",
    [validatedRequest],
    async (request, response) => {
      try {
        if (response.locals.multiUserMode)
          return response
            .status(401)
            .json({ error: "Single-user mode required." });
        const { id } = request.params;
        if (!id || isNaN(Number(id))) return response.sendStatus(400).end();

        await ApiKey.delete({ id: Number(id) });
        await emitAuditEvent(
          "api_key_deleted",
          { deletedBy: response.locals?.user?.username },
          response?.locals?.user?.id
        );
        return response.status(200).end();
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/custom-models",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (request, response) => {
      try {
        const {
          provider,
          apiKey = null,
          basePath = null,
          options = {},
        } = reqBody(request);
        const { models, error } = await getCustomModels(
          provider,
          apiKey,
          basePath,
          options
        );
        return response.status(200).json({
          models,
          error,
        });
      } catch (error) {
        console.error(error);
        response.status(500).end();
      }
    }
  );

  app.post(
    "/system/event-logs",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (request, response) => {
      try {
        const { offset = 0, limit = 10 } = reqBody(request);
        const logs = await EventLogs.whereWithData({}, limit, offset * limit, {
          id: "desc",
        });
        const totalLogs = await EventLogs.count();
        const hasPages = totalLogs > (offset + 1) * limit;

        response.status(200).json({ logs: logs, hasPages, totalLogs });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/event-logs",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (_, response) => {
      try {
        await EventLogs.delete();
        await emitAuditEvent(
          "event_logs_cleared",
          {},
          response?.locals?.user?.id
        );
        response.json({ success: true });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/system/workspace-chats",
    [
      validatedRequest,
      requirePermission("chat.read_others", orgResource),
    ],
    async (request, response) => {
      try {
        const { offset = 0, limit = 20 } = reqBody(request);
        const chats = await WorkspaceChats.whereWithData(
          {},
          limit,
          offset * limit,
          { id: "desc" }
        );
        const totalChats = await WorkspaceChats.count();
        const hasPages = totalChats > (offset + 1) * limit;

        response.status(200).json({ chats: chats, hasPages, totalChats });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/system/workspace-chats/:id",
    [validatedRequest, requirePermission("chat.write", orgResource)],
    async (request, response) => {
      try {
        const { id } = request.params;
        Number(id) === -1
          ? await WorkspaceChats.delete({}, true)
          : await WorkspaceChats.delete({ id: Number(id) });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // T-7 (#31, D-1 + #40A): what may THIS caller do, org-wide.
  //
  // Replaces the instance-wide DisableViewChatHistory flag the UI used to read.
  // A flag says what the instance forbids everyone, which cannot answer a
  // per-principal question — and answering it per-principal is what lets the UI
  // stop gating on role strings (T-8).
  //
  // This gates AFFORDANCES, never access: every route re-decides on its own, so
  // a stale or forged answer here shows a menu item that then refuses.
  app.get(
    "/system/my-capabilities",
    [validatedRequest],
    async (request, response) => {
      try {
        const actor = await resolveActor(request, response);
        // No actor is not an error — an anonymous caller simply has nothing.
        if (!actor) return response.status(200).json({ capabilities: {} });

        const engine = new DatabaseAuthorizationEngine();
        const org = { type: "org", id: "1", orgId: 1, workspaceId: null };

        // One decision per action, batched. ORG_CAPABILITIES is deliberately a
        // fixed list rather than "every seeded action": the UI asks about what
        // it actually gates, and an endpoint that enumerates the whole
        // vocabulary would hand any caller a map of the permission model.
        const decisions = await Promise.all(
          ORG_CAPABILITIES.map(async (action) => {
            const result = await engine.authorizeMany({
              actor,
              action,
              resources: [org],
            });
            return [action, result.get(0)?.allowed === true];
          })
        );

        const answer = { capabilities: Object.fromEntries(decisions) };

        // #40 task 2: the two halves are separated by ORDER plus a private
        // catch — the org batch is fully resolved and stored in `answer` before
        // this runs, and workspaceCapabilities never re-throws. That is what
        // keeps a workspace-half failure from erasing every org capability, the
        // failure the #53 comment at the top of this file warns about.
        // Sharing one try/catch is enough to reintroduce it.
        if (request.query.workspaceId !== undefined) {
          answer.workspace = await workspaceCapabilities({
            actor,
            engine,
            user: response.locals?.user,
            workspaceId: request.query.workspaceId,
          });
        }

        response.status(200).json(answer);
      } catch (e) {
        console.error(e.message, e);
        // Fail closed: a capability we cannot confirm is one we do not offer.
        response.status(200).json({ capabilities: {} });
      }
    }
  );

  app.get(
    "/system/export-chats",
    [
      validatedRequest,
      // D-2: reading other people's chats and bulk-extracting them are
      // separately grantable, and this route does both. Requiring only the
      // export permission would let someone with no right to read a single
      // conversation download all of them at once.
      requirePermission("chat.read_others", orgResource),
      requirePermission("document.bulk_export", orgResource),
    ],
    async (request, response) => {
      try {
        const { type = "jsonl", chatType = "workspace" } = request.query;
        const { contentType, data } = await exportChatsAsType(type, chatType);
        await emitAuditEvent(
          "exported_chats",
          {
            type,
            chatType,
          },
          response.locals.user?.id
        );
        response.setHeader("Content-Type", contentType);
        response.status(200).send(data);
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );

  // Used for when a user in multi-user updates their own profile
  // from the UI.
  // #52: self-service — edits the CALLER'S own profile, so an impersonated
  // session may not use it. Without this an admin viewing as a user could set
  // that user's username and password and then log in as them for real.
  app.post(
    "/system/user",
    [validatedRequest, requireSelfSession],
    async (request, response) => {
    try {
      const sessionUser = await userFromSession(request, response);
      const { username, password, bio } = reqBody(request);
      const id = Number(sessionUser.id);

      if (!id) {
        response.status(400).json({ success: false, error: "Invalid user ID" });
        return;
      }

      const updates = {};
      // If the username is being changed, validate it.
      // Otherwise, do not attempt to validate it to allow existing users to keep their username if not changing it.
      if (username !== sessionUser.username)
        updates.username = User.validations.username(String(username));
      if (password) updates.password = String(password);
      if (bio) updates.bio = String(bio);

      if (Object.keys(updates).length === 0) {
        response
          .status(400)
          .json({ success: false, error: "No updates provided" });
        return;
      }

      const { success, error } = await User.update(id, updates);
      response.status(200).json({ success, error });
    } catch (e) {
      console.error(e);
      response
        .status(500)
        .json({ success: false, error: e.message || "Internal server error" });
    }
    }
  );

  app.get(
    "/system/slash-command-presets",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
        response.status(200).json({ presets: userPresets });
      } catch (error) {
        console.error("Error fetching slash command presets:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (isReservedCommand(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot create a preset with a command that matches a system command",
          });
        }

        const presetData = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.create(user?.id, presetData);
        if (!preset) {
          return response
            .status(500)
            .json({ message: "Failed to create preset" });
        }
        response.status(201).json({ preset });
      } catch (error) {
        console.error("Error creating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.post(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slashCommandId } = request.params;
        const { command, prompt, description } = reqBody(request);
        const formattedCommand = SlashCommandPresets.formatCommand(
          String(command)
        );

        if (isReservedCommand(formattedCommand)) {
          return response.status(400).json({
            message:
              "Cannot update a preset to use a command that matches a system command",
          });
        }

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response.status(404).json({ message: "Preset not found" });

        const updates = {
          command: formattedCommand,
          prompt: String(prompt),
          description: String(description),
        };

        const preset = await SlashCommandPresets.update(
          Number(slashCommandId),
          updates
        );
        if (!preset) return response.sendStatus(422);
        response.status(200).json({ preset: { ...ownsPreset, ...updates } });
      } catch (error) {
        console.error("Error updating slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.delete(
    "/system/slash-command-presets/:slashCommandId",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const { slashCommandId } = request.params;
        const user = await userFromSession(request, response);

        // Valid user running owns the preset if user session is valid.
        const ownsPreset = await SlashCommandPresets.get({
          userId: user?.id ?? null,
          id: Number(slashCommandId),
        });
        if (!ownsPreset)
          return response
            .status(403)
            .json({ message: "Failed to delete preset" });

        await SlashCommandPresets.delete(Number(slashCommandId));
        response.sendStatus(204);
      } catch (error) {
        console.error("Error deleting slash command preset:", error);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.get(
    "/system/prompt-variables",
    [validatedRequest, requirePermission("system.read", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const variables = await SystemPromptVariables.getAll(user?.id);
        response.status(200).json({ variables });
      } catch (error) {
        console.error("Error fetching system prompt variables:", error);
        response.status(500).json({
          success: false,
          error: `Failed to fetch system prompt variables: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/prompt-variables",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.create({
          key,
          value,
          description,
          userId: user?.id || null,
        });

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error creating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to create system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.put(
    "/system/prompt-variables/:id",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const { id } = request.params;
        const { key, value, description = null } = reqBody(request);

        if (!key || !value) {
          return response.status(400).json({
            success: false,
            error: "Key and value are required",
          });
        }

        const variable = await SystemPromptVariables.update(Number(id), {
          key,
          value,
          description,
        });

        if (!variable) {
          return response.status(404).json({
            success: false,
            error: "Variable not found",
          });
        }

        response.status(200).json({
          success: true,
          variable,
        });
      } catch (error) {
        console.error("Error updating system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to update system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.delete(
    "/system/prompt-variables/:id",
    [validatedRequest, requirePermission("system.write", orgResource)],
    async (request, response) => {
      try {
        const { id } = request.params;
        const success = await SystemPromptVariables.delete(Number(id));

        if (!success) {
          return response.status(404).json({
            success: false,
            error: "System prompt variable not found or could not be deleted",
          });
        }

        response.status(200).json({
          success: true,
        });
      } catch (error) {
        console.error("Error deleting system prompt variable:", error);
        response.status(500).json({
          success: false,
          error: `Failed to delete system prompt variable: ${error.message}`,
        });
      }
    }
  );

  app.post(
    "/system/transcribe-audio",
    [
      validatedRequest,
      requirePermission("system.read", orgResource),
      handleAudioUpload,
    ],
    async (request, response) => {
      try {
        if (!request.file?.buffer) {
          return response
            .status(400)
            .json({ success: false, error: "No audio file provided." });
        }

        const provider = process.env.STT_PROVIDER || "native";
        if (provider === "native") {
          return response.status(400).json({
            success: false,
            error:
              "Server-side transcription is disabled. Set STT_PROVIDER to a supported provider.",
          });
        }

        const { getSTTProvider } = require("../utils/SpeechToText");
        const stt = getSTTProvider();
        const text = await stt.transcribe(
          request.file.buffer,
          request.file.originalname || "audio.webm"
        );
        return response.status(200).json({ success: true, text });
      } catch (error) {
        console.error("STT transcription error:", error);
        return response.status(500).json({
          success: false,
          error: error.message || "Transcription failed",
        });
      }
    }
  );

  app.post(
    "/system/validate-sql-connection",
    [validatedRequest, requirePermission("settings.write", orgResource)],
    async (request, response) => {
      const { engine, connectionString } = reqBody(request);
      try {
        if (!engine || !connectionString) {
          return response.status(400).json({
            success: false,
            error: "Both engine and connection details are required.",
          });
        }

        const {
          validateConnection,
        } = require("../utils/agents/aibitat/plugins/sql-agent/SQLConnectors");
        const result = await validateConnection(engine, { connectionString });

        if (!result.success) {
          return response.status(200).json({
            success: false,
            error: `Unable to connect to ${engine}. Please verify your connection details.`,
          });
        }

        response.status(200).json(result);
      } catch (error) {
        console.error("SQL validation error:", error);
        response.status(500).json({
          success: false,
          error: `Unable to connect to ${engine}. Please verify your connection details.`,
        });
      }
    }
  );
}

module.exports = {
  systemEndpoints,
  ORG_CAPABILITIES,
  WORKSPACE_CAPABILITIES,
  // Exported for #40 task 2's tests: the catch below is the whole point of the
  // split, and an HTTP test cannot make the engine throw without a seam. A test
  // that cannot reach the failing path asserts the property without exercising
  // it.
  workspaceCapabilities,
};
