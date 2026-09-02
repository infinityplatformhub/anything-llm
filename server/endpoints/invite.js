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

        // S11a (#80), QA-1 O1: input the CALLER can fix is validated first, and
        // before the invite is looked at. These messages are meant to be read —
        // withholding them would leave someone retyping a password that can
        // never be accepted — but they must not depend on whether the code was
        // real, or the fact that a useful answer arrived becomes the oracle.
        const inputError = User.validateNewCredentials({ username, password });
        if (inputError) {
          response.status(200).json({ success: false, error: inputError });
          return;
        }

        // Everything from here is ONE answer. Reaching `User.create` at all used
        // to prove the code was valid and pending, so a username collision was
        // answered differently from an unknown code — confirming a live invite
        // to anyone willing to guess, without redeeming it.
        const refusal = {
          success: false,
          error: "Invite not found or is invalid.",
        };

        const invite = await Invite.get({ code });
        if (!invite || invite.status !== "pending") {
          response.status(200).json(refusal);
          return;
        }

        const { user, error } = await User.create({
          username,
          password,
          role: "default",
        });
        if (!user) {
          // Logged, never returned: the operator needs to know a duplicate
          // username blocked a signup; the caller must not learn that their code
          // got far enough to try.
          console.error("Accepting invite:", error);
          response.status(200).json(refusal);
          return;
        }

        const { success: claimed } = await Invite.markClaimed(invite.id, user);
        if (!claimed) {
          // Lost a race, or it expired between the read and the claim. The user
          // row exists but owns nothing this invite granted; answering success
          // would be a lie about workspace access.
          console.error("Accepting invite: claim failed after user creation");
          response.status(200).json(refusal);
          return;
        }
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
