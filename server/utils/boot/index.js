const {
  reportUsersWithoutAccess,
} = require("../authorization/legacyRoleGrants");
const {
  migrateChatHistoryPermission,
} = require("../authorization/chatHistoryMigration");
const { Telemetry } = require("../../models/telemetry");
const { BackgroundService } = require("../BackgroundWorkers");
const { EncryptionManager } = require("../EncryptionManager");
const { CommunicationKey } = require("../comKey");
const setupTelemetry = require("../telemetry");
const eagerLoadContextWindows = require("./eagerLoadContextWindows");
const markOnboarded = require("./markOnboarded");
const { PushNotifications } = require("../PushNotifications");
const { TelegramBotService } = require("../telegramBot");
const { startEventServices } = require("../events");
const { jobRuntime } = require("../jobs/JobRuntime");
const { loadStoredCredentials } = require("../helpers/updateENV");
const {
  reportLegacyWildcardGrants,
} = require("../apiKeySecurity/legacyWildcardReport");
const { repairDeploymentShape } = require("./assertDeploymentShape");
const {
  reportRetrievalFilterSupport,
} = require("../authorization/retrievalSupport");
const {
  reportChatSearchLocaleSupport,
} = require("../chatSearch/localeSupport");

// Testing SSL? You can make a self signed certificate and point the ENVs to that location
// make a directory in server called 'sslcert' - cd into it
// - openssl genrsa -aes256 -passout pass:gsahdg -out server.pass.key 4096
// - openssl rsa -passin pass:gsahdg -in server.pass.key -out server.key
// - rm server.pass.key
// - openssl req -new -key server.key -out server.csr
// Update .env keys with the correct values and boot. These are temporary and not real SSL certs - only use for local.
// Test with https://localhost:3001/api/ping
// build and copy frontend to server/public with correct API_BASE and start server in prod model and all should be ok
async function bootSSL(app, port = 3001, { credentialStore = null } = {}) {
  // issue 58: before listen(). The callbacks below run AFTER the socket is
  // open, and the repair must land before the first request is authorized.
  await repairDeploymentShape();
  // #115: same reason, same place. This used to sit first INSIDE the listen()
  // callback, which is first among the callback's own steps but still after the
  // socket is open — so every request in that window read all 97 `secret: true`
  // keys as undefined. Since #48 the database row is the only copy, so that
  // window is the difference between configured and not configured, not a cold
  // cache. Boot is ~2.5s slower on a 97-key deployment until #117 stops
  // re-deriving the store key per row; slower boot, not a hang.
  await loadStoredCredentials(credentialStore);
  try {
    console.log(
      `\x1b[33m[SSL BOOT ENABLED]\x1b[0m Loading the certificate and key for HTTPS mode...`
    );
    const fs = require("fs");
    const https = require("https");
    const privateKey = fs.readFileSync(process.env.HTTPS_KEY_PATH);
    const certificate = fs.readFileSync(process.env.HTTPS_CERT_PATH);
    const credentials = { key: privateKey, cert: certificate };
    const server = https.createServer(credentials, app);

    server
      .listen(port, async () => {
        // Credentials are already in process.env (above, before listen): the
        // steps here may construct provider clients and must see them.
        await markOnboarded();
        await setupTelemetry();
        new CommunicationKey(true);
        new EncryptionManager();
        new BackgroundService().boot();
        await startEventServices();
      // T-4a (#25): surface users stranded without workspace access on every
      // boot, not once as a migration NOTICE nobody reads twice.
      // T-7 (#31): one-shot, marker-guarded; the env var it reads is invisible
      // to SQL, so this cannot be a migration.
      await migrateChatHistoryPermission();
      await reportUsersWithoutAccess();
        await jobRuntime.start();
        await eagerLoadContextWindows();
        await PushNotifications.setupPushNotificationService();
        await TelegramBotService.bootIfActive();
        await reportLegacyWildcardGrants();
        // T-5 (#30): say at boot whether this deployment's vector provider can enforce
        // the document ACL. Providers that cannot refuse retrieval rather than serve it
        // unfiltered, and that refusal must not be first discovered by a user.
        await reportRetrievalFilterSupport();
        // V9 (#61): say at boot whether pg_trgm can index Thai on this database.
        // A C-locale database yields no trigrams for Thai, so Thai chat search
        // silently falls back to a full table scan — correct results, wrong
        // performance, and nothing in the logs unless we say so.
        await reportChatSearchLocaleSupport();
        console.log(`Primary server in HTTPS mode listening on port ${port}`);
      })
      .on("error", catchSigTerms);

    require("@mintplex-labs/express-ws").default(app, server);
    return { app, server };
  } catch (e) {
    console.error(
      `\x1b[31m[SSL BOOT FAILED]\x1b[0m ${e.message} - falling back to HTTP boot.`,
      {
        ENABLE_HTTPS: process.env.ENABLE_HTTPS,
        HTTPS_KEY_PATH: process.env.HTTPS_KEY_PATH,
        HTTPS_CERT_PATH: process.env.HTTPS_CERT_PATH,
        stacktrace: e.stack,
      }
    );
    return await bootHTTP(app, port, { credentialStore });
  }
}

async function bootHTTP(app, port = 3001, { credentialStore = null } = {}) {
  if (!app) throw new Error('No "app" defined - crashing!');
  await repairDeploymentShape();
  // #115: before listen(), for the reason spelled out in bootSSL.
  await loadStoredCredentials(credentialStore);

  const server = app
    .listen(port, async () => {
      // Credentials are already in process.env (above, before listen).
      await markOnboarded();
      await setupTelemetry();
      new CommunicationKey(true);
      new EncryptionManager();
      new BackgroundService().boot();
      await startEventServices();
      // T-4a (#25): surface users stranded without workspace access on every
      // boot, not once as a migration NOTICE nobody reads twice.
      // T-7 (#31): one-shot, marker-guarded; the env var it reads is invisible
      // to SQL, so this cannot be a migration.
      await migrateChatHistoryPermission();
      await reportUsersWithoutAccess();
      await jobRuntime.start();
      await eagerLoadContextWindows();
      await PushNotifications.setupPushNotificationService();
      await TelegramBotService.bootIfActive();
      await reportLegacyWildcardGrants();
      // T-5 (#30): see bootSSL.
      await reportRetrievalFilterSupport();
      // V9 (#61): see bootSSL.
      await reportChatSearchLocaleSupport();
      console.log(`Primary server in HTTP mode listening on port ${port}`);
    })
    .on("error", catchSigTerms);

  // #115: returned so a test can reach the port and race the boot. Production
  // (index.js:218) ignores the return value; bootSSL already returned its
  // server for express-ws.
  return { app, server };
}

function catchSigTerms() {
  process.once("SIGUSR2", function () {
    Telemetry.flush();
    process.kill(process.pid, "SIGUSR2");
  });
  process.on("SIGINT", function () {
    Telemetry.flush();
    process.kill(process.pid, "SIGINT");
  });
}

module.exports = {
  bootHTTP,
  bootSSL,
};
