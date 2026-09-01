const { emitAuditEvent } = require("../utils/events");
const { Invite } = require("../models/invite");
const { User } = require("../models/user");
const { reqBody } = require("../utils/http");
const {
  simpleSSOLoginDisabledMiddleware,
} = require("../utils/middleware/simpleSSOEnabled");
const { inviteRateLimit } = require("../utils/middleware/requestControls");

function inviteEndpoints(app) {
  if (!app) return;

  app.get("/invite/:code", inviteRateLimit, async (request, response) => {
    try {
      const { code } = request.params;
      const invite = await Invite.get({ code });
      if (!invite || invite.status !== "pending") {
        response
          .status(200)
          .json({ invite: null, error: "Invite not found or is invalid." });
        return;
      }

      response
        .status(200)
        .json({ invite: { code, status: invite.status }, error: null });
    } catch (e) {
      console.error(e);
      response.sendStatus(500).end();
    }
  });

  app.post(
    "/invite/:code",
    [inviteRateLimit, simpleSSOLoginDisabledMiddleware],
    async (request, response) => {
      try {
        const { code } = request.params;
        const { username, password } = reqBody(request);
        const invite = await Invite.get({ code });
        if (!invite || invite.status !== "pending") {
          response
            .status(200)
            .json({ success: false, error: "Invite not found or is invalid." });
          return;
        }

        const { user, error } = await User.create({
          username,
          password,
          role: "default",
        });
        if (!user) {
          console.error("Accepting invite:", error);
          response.status(200).json({ success: false, error });
          return;
        }

        await Invite.markClaimed(invite.id, user);
        await emitAuditEvent(
          "invite_accepted",
          {
            username: user.username,
          },
          user.id
        );

        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { inviteEndpoints };
