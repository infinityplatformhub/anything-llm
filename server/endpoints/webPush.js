const { reqBody } = require("../utils/http");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { pushNotificationService } = require("../utils/PushNotifications");
const {
  requireSelfSession,
} = require("../utils/middleware/requireSelfSession");

function webPushEndpoints(app) {
  if (!app) return;

  app.post(
    "/web-push/subscribe",
    // #52: self-service — binds a caller-supplied push endpoint to
    // `locals.user`, so an impersonated session could point the victim's
    // notifications at an attacker's endpoint.
    [validatedRequest, requireSelfSession],
    async (request, response) => {
      const subscription = reqBody(request);
      await pushNotificationService.registerSubscription(
        response.locals.user,
        subscription
      );
      response.status(201).json({});
    }
  );

  app.get("/web-push/pubkey", [validatedRequest], (_request, response) => {
    const publicKey = pushNotificationService.publicVapidKey;
    response.status(200).json({ publicKey });
  });
}

module.exports = { webPushEndpoints };
