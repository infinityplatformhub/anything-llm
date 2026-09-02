const prisma = require("../utils/prisma");
const { safeJSONStringify } = require("../utils/helpers/chat/responses");

// V9 (#61): search bounds.
//
// The floor is not a usability preference: a one-character needle has no
// trigram to look up, so the GIN index cannot serve it and the query degrades
// to a full scan of every chat the user owns. The ceiling bounds the pattern a
// caller can push into the planner.
const MIN_SEARCH_LENGTH = 2;
const MAX_SEARCH_LENGTH = 200;

// LIKE metacharacters are literal text to someone searching their own chat
// history — a user looking for "100%" means the string, not "everything".
// Backslash first, or it would re-escape the escapes added after it.
// Postgres's default LIKE escape character is the backslash, so no ESCAPE
// clause is needed (and Prisma's `contains` has nowhere to put one).
const escapeLike = (value) =>
  String(value).replace(/[\\%_]/g, (character) => `\\${character}`);

const WorkspaceChats = {
  new: async function ({
    workspaceId,
    prompt,
    response = {},
    user = null,
    threadId = null,
    include = true,
    apiSessionId = null,
  }) {
    try {
      const chat = await prisma.workspace_chats.create({
        data: {
          workspaceId,
          prompt,
          response: safeJSONStringify(response),
          // V9 (#61): the searchable projection of the answer. Taken from the
          // object before it is stringified, so a `response` that safeJSONStringify
          // has to degrade cannot leave a mismatched projection behind. Non-string
          // text stores NULL rather than a coerced "[object Object]" — the read
          // path already skips such records (convertToChatHistory), so they are not
          // findable either.
          response_text:
            typeof response?.text === "string" ? response.text : null,
          user_id: user?.id || null,
          thread_id: threadId,
          api_session_id: apiSessionId,
          include,
        },
      });
      return { chat, message: null };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },

  forWorkspaceByUser: async function (
    workspaceId = null,
    userId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !userId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: userId,
          thread_id: null, // this function is now only used for the default thread on workspaces and users
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  // V9 (#61): substring search over ONE user's own chats in ONE workspace.
  //
  // `userId` is required, and an absent one returns [] rather than falling back to
  // an unfiltered read. That is the specific failure this function is shaped to
  // avoid: forWorkspaceByUser and forWorkspace differ only by that predicate, and
  // the route picks between them on a boolean — so an unfiltered read is always one
  // wrong branch away. Here there is no unfiltered branch to reach.
  //
  // `chat.read_others` deliberately does not widen this (V9 scope is the caller's
  // own history); cross-user and cross-workspace search are V10, which owns the
  // leak tests for them.
  searchForUser: async function ({
    workspaceId = null,
    userId = null,
    query = "",
    limit = 50,
    beforeId = null,
  }) {
    if (!workspaceId || !userId) return [];
    const needle = String(query ?? "").trim();
    if (needle.length < MIN_SEARCH_LENGTH || needle.length > MAX_SEARCH_LENGTH)
      return [];

    try {
      return await prisma.workspace_chats.findMany({
        where: {
          user_id: userId,
          workspaceId,
          api_session_id: null, // dev-API chats never surface in the frontend
          include: true,
          ...(beforeId !== null ? { id: { lt: beforeId } } : {}),
          OR: [
            { prompt: { contains: escapeLike(needle), mode: "insensitive" } },
            {
              response_text: {
                contains: escapeLike(needle),
                mode: "insensitive",
              },
            },
          ],
        },
        orderBy: { id: "desc" },
        take: limit,
      });
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspaceByApiSessionId: async function (
    workspaceId = null,
    apiSessionId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId || !apiSessionId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          user_id: null,
          api_session_id: String(apiSessionId),
          thread_id: null,
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  forWorkspace: async function (
    workspaceId = null,
    limit = null,
    orderBy = null
  ) {
    if (!workspaceId) return [];
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: {
          workspaceId,
          thread_id: null, // this function is now only used for the default thread on workspaces
          api_session_id: null, // do not include api-session chats in the frontend for anyone.
          include: true,
        },
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : { orderBy: { id: "asc" } }),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  /**
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markHistoryInvalid: async function (workspaceId = null, user = null) {
    if (!workspaceId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          user_id: user?.id,
          thread_id: null, // this function is now only used for the default thread on workspaces
          api_session_id: null, // API session chats also live on the default thread - a UI reset must not clear them
        },
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  /**
   * @deprecated Use markThreadHistoryInvalidV2 instead.
   */
  markThreadHistoryInvalid: async function (
    workspaceId = null,
    user = null,
    threadId = null
  ) {
    if (!workspaceId || !threadId) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: {
          workspaceId,
          thread_id: threadId,
          user_id: user?.id,
        },
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  /**
   * @description This function is used to mark a thread's history as invalid.
   * and works with an arbitrary where clause.
   * @param {Object} whereClause - The where clause to update the chats.
   * @param {Object} data - The data to update the chats with.
   * @returns {Promise<void>}
   */
  markThreadHistoryInvalidV2: async function (whereClause = {}) {
    if (!whereClause) return;
    try {
      await prisma.workspace_chats.updateMany({
        where: whereClause,
        data: {
          include: false,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  get: async function (clause = {}, limit = null, orderBy = null) {
    try {
      const chat = await prisma.workspace_chats.findFirst({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return chat || null;
    } catch (error) {
      console.error(error.message);
      return null;
    }
  },

  delete: async function (clause = {}) {
    try {
      await prisma.workspace_chats.deleteMany({
        where: clause,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  where: async function (
    clause = {},
    limit = null,
    orderBy = null,
    offset = null
  ) {
    try {
      const chats = await prisma.workspace_chats.findMany({
        where: clause,
        ...(limit !== null ? { take: limit } : {}),
        ...(offset !== null ? { skip: offset } : {}),
        ...(orderBy !== null ? { orderBy } : {}),
      });
      return chats;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },

  count: async function (clause = {}) {
    try {
      const count = await prisma.workspace_chats.count({
        where: clause,
      });
      return count;
    } catch (error) {
      console.error(error.message);
      return 0;
    }
  },

  whereWithData: async function (
    clause = {},
    limit = null,
    offset = null,
    orderBy = null
  ) {
    const { Workspace } = require("./workspace");
    const { User } = require("./user");

    try {
      const results = await this.where(clause, limit, orderBy, offset);

      for (const res of results) {
        const workspace = await Workspace.get({ id: res.workspaceId });
        res.workspace = workspace
          ? { name: workspace.name, slug: workspace.slug }
          : { name: "deleted workspace", slug: null };

        const user = res.user_id ? await User.get({ id: res.user_id }) : null;
        res.user = user
          ? { username: user.username }
          : { username: res.api_session_id !== null ? "API" : "unknown user" };
      }

      return results;
    } catch (error) {
      console.error(error.message);
      return [];
    }
  },
  updateFeedbackScore: async function (chatId = null, feedbackScore = null) {
    if (!chatId) return;
    try {
      await prisma.workspace_chats.update({
        where: {
          id: Number(chatId),
        },
        data: {
          feedbackScore:
            feedbackScore === null ? null : Number(feedbackScore) === 1,
        },
      });
      return;
    } catch (error) {
      console.error(error.message);
    }
  },

  // Explicit update of settings + key validations.
  // Only use this method when directly setting a key value
  // that takes no user input for the keys being modified.
  _update: async function (id = null, data = {}) {
    if (!id) throw new Error("No workspace chat id provided for update");

    try {
      await prisma.workspace_chats.update({
        where: { id },
        data,
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },
  markMemoryProcessed: async function (ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) return;
    try {
      const safeIds = ids.map(Number).filter(Number.isInteger);
      if (safeIds.length === 0) return;
      await prisma.workspace_chats.updateMany({
        where: { id: { in: safeIds } },
        data: { memoryProcessed: true },
      });
    } catch (error) {
      console.error(error.message);
    }
  },

  migrateToMultiUser: async function (adminUserId) {
    try {
      await prisma.workspace_chats.updateMany({
        where: { user_id: null },
        data: { user_id: adminUserId },
      });
      return true;
    } catch (error) {
      console.error(error.message);
      return false;
    }
  },

  bulkCreate: async function (chatsData) {
    // TODO: Replace with createMany when we update prisma to latest version
    // The version of prisma that we are currently using does not support createMany with SQLite
    try {
      const createdChats = [];
      for (const chatData of chatsData) {
        const chat = await prisma.workspace_chats.create({
          data: chatData,
        });
        createdChats.push(chat);
      }
      return { chats: createdChats, message: null };
    } catch (error) {
      console.error(error.message);
      return { chats: null, message: error.message };
    }
  },
  upsert: async function (
    chatId = null,
    data = {
      workspaceId: null,
      prompt: null,
      response: {},
      user: null,
      threadId: null,
      include: true,
      apiSessionId: null,
    }
  ) {
    try {
      const payload = {
        workspaceId: data.workspaceId,
        response: safeJSONStringify(data.response),
        user_id: data.user?.id || null,
        thread_id: data.threadId,
        api_session_id: data.apiSessionId,
        include: data.include,
      };

      const { chat } = await prisma.workspace_chats.upsert({
        where: {
          id: Number(chatId),
          user_id: data.user?.id || null,
        },
        // On updates, we already have the prompt so we don't need to set it again.
        update: { ...payload, lastUpdatedAt: new Date() },

        // On creates, we need to set the prompt or else record will fail.
        create: { ...payload, prompt: data.prompt },
      });
      return { chat, message: null };
    } catch (error) {
      console.error(error.message);
      return { chat: null, message: error.message };
    }
  },
};

module.exports = { WorkspaceChats, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH };
