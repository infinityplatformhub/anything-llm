// Suppress deprecated content-type warning when sending files via the Telegram bot API.
// https://github.com/yagop/node-telegram-bot-api/blob/master/doc/usage.md#file-options-metadata
process.env.NTBA_FIX_350 = 1;
const TelegramBot = require("node-telegram-bot-api");
const { log, conclude } = require("./helpers/index.js");
const { Workspace } = require("../models/workspace");
const { WorkspaceThread } = require("../models/workspaceThread");
const { streamResponse } = require("../utils/telegramBot/chat/stream");
// T-4b (#29) W-11: this channel resolved any workspace by slug with no actor at all.
// It now runs as a named principal so the engine has something to evaluate.
//
// NOTE for T-5/T-7: `approved_users` (utils/telegramBot/index.js:369) stores chatId,
// telegram username and the active workspace slug — it carries NO AnythingLLM user id, so
// there is no originating user to resolve here and the channel can only run as a service
// principal. That means every verified Telegram chat shares one identity and one document
// scope. Linking approved_users to a real user row is a schema change, not wiring, and is
// out of T-4b's scope — flagged to PMO.
const { jobActor } = require("../utils/authorization/actorResolver");

process.on("message", async (payload) => {
  // Ignore tool approval responses - these are handled by http-socket plugin
  if (payload?.type === "toolApprovalResponse") return;

  const {
    botToken,
    chatId,
    workspaceSlug,
    threadSlug,
    message,
    attachments = [],
    voiceResponse = false,
  } = payload;

  try {
    const bot = new TelegramBot(botToken, { polling: false });
    const ctx = {
      bot,
      log: (text, ...args) =>
        log(args.length ? `${text} ${args.join(" ")}` : text),
    };

    const actor = await jobActor();
    const workspace = await Workspace.get({ slug: workspaceSlug });
    if (!workspace) {
      await bot.sendMessage(
        chatId,
        "No workspace configured. Use /switch to select one."
      );
      conclude();
      return;
    }

    const thread = threadSlug
      ? await WorkspaceThread.get({ slug: threadSlug })
      : null;

    await streamResponse({
      ctx,
      chatId,
      workspace,
      thread,
      message,
      attachments,
      voiceResponse,
      actor,
    });
  } catch (error) {
    log(`Telegram chat error: ${error.message}`);
    try {
      const bot = new TelegramBot(botToken, { polling: false });
      await bot.sendMessage(
        chatId,
        "Sorry, something went wrong. Please try again."
      );
    } catch {}
  } finally {
    conclude();
  }
});
