process.env.NODE_ENV === "development"
  ? require("dotenv").config({ path: `.env.${process.env.NODE_ENV}` })
  : require("dotenv").config();

require("./utils/logger")();
require("./utils/boot/patchSdkTimeouts")();
require("./utils/helpers/modelPricing"); // boots the model pricing cache refresh
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const path = require("path");
const { reqBody } = require("./utils/http");
const { systemEndpoints } = require("./endpoints/system");
const { mailerEndpoints } = require("./endpoints/mailer");
const { workspaceEndpoints } = require("./endpoints/workspaces");
const { chatEndpoints } = require("./endpoints/chat");
const { embeddedEndpoints } = require("./endpoints/embed");
const { embedManagementEndpoints } = require("./endpoints/embedManagement");
const { getVectorDbClass } = require("./utils/helpers");
const { adminEndpoints } = require("./endpoints/admin");
const {
  adminAuthorizationEndpoints,
} = require("./endpoints/admin/authorization");
const { modelRouterEndpoints } = require("./endpoints/modelRouter");
const { inviteEndpoints } = require("./endpoints/invite");
const { utilEndpoints } = require("./endpoints/utils");
const { developerEndpoints } = require("./endpoints/api");
const { extensionEndpoints } = require("./endpoints/extensions");
const { bootHTTP, bootSSL } = require("./utils/boot");
const { sealRoutes } = require("./utils/boot/sealRoutes");
const { workspaceThreadEndpoints } = require("./endpoints/workspaceThreads");
const { documentEndpoints } = require("./endpoints/document");
const { agentWebsocket } = require("./endpoints/agentWebsocket");
const {
  agentSkillWhitelistEndpoints,
} = require("./endpoints/agentSkillWhitelist");
const { agentFileServerEndpoints } = require("./endpoints/agentFileServer");
const { experimentalEndpoints } = require("./endpoints/experimental");
const { browserExtensionEndpoints } = require("./endpoints/browserExtension");
const { communityHubEndpoints } = require("./endpoints/communityHub");
const { agentFlowEndpoints } = require("./endpoints/agentFlows");
const { mcpServersEndpoints } = require("./endpoints/mcpServers");
const { mobileEndpoints } = require("./endpoints/mobile");
const { webPushEndpoints } = require("./endpoints/webPush");
const { telegramEndpoints } = require("./endpoints/telegram");
const { scheduledJobEndpoints } = require("./endpoints/scheduledJobs");
const {
  outlookAgentEndpoints,
} = require("./endpoints/utils/outlookAgentUtils");
const {
  googleAgentSkillEndpoints,
} = require("./endpoints/utils/googleAgentSkillEndpoints");
const { memoryEndpoints } = require("./endpoints/memory");
const { auditEndpoints } = require("./endpoints/audit");
const { identityEndpoints } = require("./endpoints/identity");
const { samlIdentityEndpoints } = require("./endpoints/identity/saml");
const { ldapIdentityEndpoints } = require("./endpoints/identity/ldap");
const {
  directorySyncEndpoints,
} = require("./endpoints/identity/directorySync");
const { httpLogger } = require("./middleware/httpLogger");
const {
  apiIpRateLimit,
  apiKeyRateLimit,
  ipAllowlist,
} = require("./utils/middleware/requestControls");
const app = express();
const apiRouter = express.Router();
const FILE_LIMIT = "3GB";

// Only log HTTP requests in development mode and if the ENABLE_HTTP_LOGGER environment variable is set to true
if (
  process.env.NODE_ENV === "development" &&
  !!process.env.ENABLE_HTTP_LOGGER
) {
  app.use(
    httpLogger({
      enableTimestamps: !!process.env.ENABLE_HTTP_LOGGER_TIMESTAMPS,
    })
  );
}
app.use(cors({ origin: true }));
app.use(bodyParser.text({ limit: FILE_LIMIT }));
app.use(bodyParser.json({ limit: FILE_LIMIT }));
app.use(
  bodyParser.urlencoded({
    limit: FILE_LIMIT,
    extended: true,
  })
);

const refuseBoot = (error) => {
  // issue 58: boot is async (the deployment-shape repair runs before listen).
  // A rejection here means the server never started, so it must be reported and
  // exit non-zero rather than surface as an unhandled promise rejection.
  console.error(`\x1b[31m[BOOT FAILED]\x1b[0m ${error.message}`);
  process.exit(1);
};

if (!!process.env.ENABLE_HTTPS) {
  bootSSL(app, process.env.SERVER_PORT || 3001).catch(refuseBoot);
} else {
  require("@mintplex-labs/express-ws").default(app); // load WebSockets in non-SSL mode.
}

app.use("/api", ipAllowlist, apiRouter);
apiRouter.use("/v1", apiIpRateLimit, apiKeyRateLimit);
const ENDPOINT_REGISTRATIONS = Object.freeze([
  systemEndpoints,
  mailerEndpoints,
  extensionEndpoints,
  workspaceEndpoints,
  workspaceThreadEndpoints,
  chatEndpoints,
  adminEndpoints,
  adminAuthorizationEndpoints,
  modelRouterEndpoints,
  inviteEndpoints,
  embedManagementEndpoints,
  utilEndpoints,
  documentEndpoints,
  agentWebsocket,
  agentSkillWhitelistEndpoints,
  agentFileServerEndpoints,
  experimentalEndpoints,
  { register: developerEndpoints, withApp: true },
  communityHubEndpoints,
  agentFlowEndpoints,
  mcpServersEndpoints,
  mobileEndpoints,
  webPushEndpoints,
  telegramEndpoints,
  scheduledJobEndpoints,
  outlookAgentEndpoints,
  googleAgentSkillEndpoints,
  memoryEndpoints,
  auditEndpoints,
  // SAML must precede OIDC's `/sso/:provider/login` wildcard.
  samlIdentityEndpoints,
  // S3 (#60): a concrete route under /sso/ must precede S1's wildcard, which
  // would otherwise swallow it (the cd4fda5e defect).
  ldapIdentityEndpoints,
  // S4b slice 3 (#138): sync-now. Not under /sso/, so ordering against S1's
  // wildcard does not apply — mounted beside its siblings for findability.
  directorySyncEndpoints,
  identityEndpoints,
  // Public embed and browser-extension routes remain last.
  embeddedEndpoints,
  browserExtensionEndpoints,
]);

for (const entry of ENDPOINT_REGISTRATIONS) {
  const register = typeof entry === "function" ? entry : entry.register;
  typeof entry === "function" ? register(apiRouter) : register(app, apiRouter);
}

if (process.env.NODE_ENV !== "development") {
  const { MetaGenerator } = require("./utils/boot/MetaGenerator");
  const IndexPage = new MetaGenerator();

  app.use(
    express.static(path.resolve(__dirname, "public"), {
      extensions: ["js"],
      setHeaders: (res) => {
        // Disable I-framing of entire site UI
        res.removeHeader("X-Powered-By");
        res.setHeader("X-Frame-Options", "DENY");
      },
    })
  );

  app.get("/robots.txt", function (_, response) {
    response.type("text/plain");
    response.send("User-agent: *\nDisallow: /").end();
  });

  app.get("/manifest.json", async function (_, response) {
    IndexPage.generateManifest(response);
    return;
  });

  app.use("/", function (_, response) {
    IndexPage.generate(response);
    return;
  });
} else {
  // Debug route for development connections to vectorDBs
  apiRouter.post("/v/:command", async (request, response) => {
    try {
      const VectorDb = getVectorDbClass();
      const { command } = request.params;
      if (!Object.getOwnPropertyNames(VectorDb).includes(command)) {
        response.status(500).json({
          message: "invalid interface command",
          commands: Object.getOwnPropertyNames(VectorDb),
        });
        return;
      }

      try {
        const body = reqBody(request);
        const resBody = await VectorDb[command](body);
        response.status(200).json({ ...resBody });
      } catch (e) {
        // console.error(e)
        console.error(JSON.stringify(e));
        response.status(500).json({ error: e.message });
      }
      return;
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });
}

// #98: boot is over. Anything mounting a mutating route after this point is
// invisible to routeGateSweep — which asserts at a moment, so a mount scheduled
// past it ships ungated and green — and is refused from here on.
//
// HERE, not at the end of the registration loop: the development branch above
// mounts `apiRouter.post("/v/:command")` after that loop, so arming earlier would
// throw on every dev boot. This point is also where the codebase already draws the
// line — the terminal 404 below must be last, and routeGateSweep asserts it is.
// The terminal 404 is mounted BEFORE the seal, because `all` is one of the sealed
// methods (TL-2: express's `app.all` does not route through `app.post`, so leaving
// it unsealed is a bypass by definition — and #40's R3 mutation was `apiRouter.all`).
// It has to be last in the stack and it has to be inside the seal point; mounting it
// here satisfies both, and routeGateSweep still asserts it is the final layer.
const terminalNotFound = function (_, response) {
  response.sendStatus(404);
};
app.all("*", terminalNotFound);

sealRoutes(app, apiRouter);

// In non-https mode we need to boot at the end since the server has not yet
// started and is `.listen`ing.
if (require.main === module && !process.env.ENABLE_HTTPS)
  bootHTTP(app, process.env.SERVER_PORT || 3001).catch(refuseBoot);

module.exports = { app, ENDPOINT_REGISTRATIONS, terminalNotFound };
