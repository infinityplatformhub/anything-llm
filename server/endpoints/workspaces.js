const {
  reqBody,
  multiUserMode,
  userFromSession,
  safeJsonParse,
} = require("../utils/http");
const { moveProcessedDocsToFolder } = require("../utils/files");
const { Workspace } = require("../models/workspace");
const { Document } = require("../models/documents");
const { DocumentVectors } = require("../models/vectors");
const { WorkspaceChats, MIN_SEARCH_LENGTH, MAX_SEARCH_LENGTH } = require("../models/workspaceChats"); // §5.1: single line — the gate greps the model name on the same line as require(
const {
  chatSearchRateLimit,
} = require("../utils/middleware/requestControls");

// V9 (#61): one page of search hits. Bounded here rather than taken from the
// caller — an unbounded page is the whole history, which is the thing search
// exists to avoid returning.
const SEARCH_PAGE_SIZE = 50;
const { getVectorDbClass, stripThinkingFromText } = require("../utils/helpers");
const { handleFileUpload } = require("../utils/files/multer");
const { validatedRequest } = require("../utils/middleware/validatedRequest");
const { Telemetry } = require("../models/telemetry");
const { requirePermission } = require("../utils/middleware/requirePermission");
const {
  DatabaseAuthorizationEngine,
} = require("../utils/authorization/engine");
const {
  workspaceBySlug,
  chatByIdParam,
  documentInWorkspaceBySlug,
  orgResource,
  promptHistoryByIdParam,
} = require("../utils/middleware/resourceResolvers");
const { emitAuditEvent } = require("../utils/events");
const {
  WorkspaceSuggestedMessages,
} = require("../models/workspacesSuggestedMessages");
const { validWorkspaceSlug } = require("../utils/middleware/validWorkspace");
const { convertToChatHistory } = require("../utils/helpers/chat/responses");
const { CollectorApi } = require("../utils/collectorApi");
const { getTTSProvider } = require("../utils/TextToSpeech");
const { getAudioFileInfo } = require("../utils/TextToSpeech/audioFormat");
const { WorkspaceThread } = require("../models/workspaceThread");

const truncate = require("truncate");
const { purgeDocument } = require("../utils/files/purgeDocument");
const {
  canPurgeDocumentFromWorkspace,
} = require("../utils/helpers/documentPurgeGuard");
const { getModelTag } = require("./utils");
const { searchWorkspaceAndThreads } = require("../utils/helpers/search");
const { workspaceParsedFilesEndpoints } = require("./workspacesParsedFiles");
const {
  workspaceDeletionProtection,
} = require("../utils/middleware/workspaceDeletionProtection");

const authorizationEngine = new DatabaseAuthorizationEngine();

function workspaceEndpoints(app) {
  if (!app) return;
  const responseCache = new Map();

  app.post(
    "/workspace/new",
    [validatedRequest, requirePermission("workspace.create", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { name = null } = reqBody(request);
        const { workspace, message } = await Workspace.new(name, user?.id);
        await Telemetry.sendTelemetry(
          "workspace_created",
          {
            multiUserMode: multiUserMode(response),
            LLMSelection: process.env.LLM_PROVIDER || "openai",
            Embedder: process.env.EMBEDDING_ENGINE || "inherit",
            VectorDbSelection: process.env.VECTOR_DB || "lancedb",
            TTSSelection: process.env.TTS_PROVIDER || "native",
            LLMModel: getModelTag(),
          },
          user?.id
        );

        await emitAuditEvent(
          "workspace_created",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          user?.id
        );
        response.status(200).json({ workspace, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update",
    [validatedRequest, requirePermission("workspace.write", workspaceBySlug)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slug = null } = request.params;
        const data = reqBody(request);
        const currWorkspace = await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Workspace.trackChange(currWorkspace, data, user);
        const { workspace, message } = await Workspace.update(
          currWorkspace.id,
          data
        );
        response.status(200).json({ workspace, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/upload",
    [
      validatedRequest,
      requirePermission("document.create", workspaceBySlug),
      handleFileUpload,
    ],
    async function (request, response) {
      try {
        const Collector = new CollectorApi();
        const { originalname } = request.file;

        // Multipart field order matters: multer only exposes text fields on
        // request.body that were appended BEFORE the file part, so the client
        // must append folderName/metadata first. See FileUploadProgress.
        const { folderName = null, metadata: _metadata = "{}" } =
          reqBody(request);

        const metadata =
          typeof _metadata === "string"
            ? safeJsonParse(_metadata, {})
            : _metadata;

        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error: `Document processing API is not online. Document ${originalname} will not be processed automatically.`,
            })
            .end();
          return;
        }

        const { success, reason, documents } = await Collector.processDocument(
          originalname,
          metadata
        );
        if (!success) {
          response.status(500).json({ success: false, error: reason }).end();
          return;
        }

        // When the upload is part of a folder upload, move the processed
        // documents from their default location into the target folder.
        if (!!folderName) moveProcessedDocsToFolder(documents, folderName);

        Collector.log(
          `Document ${originalname} uploaded processed and successfully. It is now available in documents.`
        );
        await Telemetry.sendTelemetry("document_uploaded");
        await emitAuditEvent(
          "document_uploaded",
          {
            documentName: originalname,
            ...(folderName ? { folder: folderName } : {}),
          },
          response.locals?.user?.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/upload-link",
    [validatedRequest, requirePermission("document.create", workspaceBySlug)],
    async (request, response) => {
      try {
        const Collector = new CollectorApi();
        const { link = "" } = reqBody(request);
        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error: `Document processing API is not online. Link ${link} will not be processed automatically.`,
            })
            .end();
          return;
        }

        const { success, reason } = await Collector.processLink(link);
        if (!success) {
          response.status(500).json({ success: false, error: reason }).end();
          return;
        }

        Collector.log(
          `Link ${link} uploaded processed and successfully. It is now available in documents.`
        );
        await Telemetry.sendTelemetry("link_uploaded");
        await emitAuditEvent(
          "link_uploaded",
          { link },
          response.locals?.user?.id
        );
        response.status(200).json({ success: true, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update-embeddings",
    [
      validatedRequest,
      requirePermission("workspace.embeddings.manage", workspaceBySlug),
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const { slug = null } = request.params;
        const { adds = [], deletes = [] } = reqBody(request);
        const currWorkspace = await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Document.removeDocuments(
          currWorkspace,
          deletes,
          response.locals?.user?.id
        );

        const {
          isNativeEmbedder,
          embedFiles,
        } = require("../utils/EmbeddingWorkerManager");

        if (isNativeEmbedder() && adds.length > 0) {
          await embedFiles(
            currWorkspace.slug,
            adds,
            currWorkspace.id,
            response.locals?.user?.id ?? null
          );
          const updatedWorkspace = await Workspace.get({
            id: currWorkspace.id,
          });
          response
            .status(200)
            .json({ workspace: updatedWorkspace, message: null });
          return;
        }

        const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
          currWorkspace,
          adds,
          response.locals?.user?.id
        );
        const updatedWorkspace = await Workspace.get({ id: currWorkspace.id });
        response.status(200).json({
          workspace: updatedWorkspace,
          message:
            failedToEmbed.length > 0
              ? `${failedToEmbed.length} documents failed to add.\n\n${errors
                  .map((msg) => `${msg}`)
                  .join("\n\n")}`
              : null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug",
    [
      validatedRequest,
      requirePermission("workspace.delete", workspaceBySlug),
      workspaceDeletionProtection,
    ],
    async (request, response) => {
      try {
        const { slug = "" } = request.params;
        const user = await userFromSession(request, response);
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        await WorkspaceChats.delete({ workspaceId: Number(workspace.id) });
        await DocumentVectors.deleteForWorkspace(workspace.id);
        await Document.delete({ workspaceId: Number(workspace.id) });
        await Workspace.delete({ id: Number(workspace.id) });

        await emitAuditEvent(
          "workspace_deleted",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          response.locals?.user?.id
        );

        try {
          await VectorDb["delete-namespace"]({ namespace: slug });
        } catch (e) {
          console.error(e.message);
        }
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/reset-vector-db",
    [
      validatedRequest,
      requirePermission("workspace.embeddings.manage", workspaceBySlug),
    ],
    async (request, response) => {
      try {
        const { slug = "" } = request.params;
        const user = await userFromSession(request, response);
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        await DocumentVectors.deleteForWorkspace(workspace.id);
        await Document.delete({ workspaceId: Number(workspace.id) });

        await emitAuditEvent(
          "workspace_vectors_reset",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
          },
          response.locals?.user?.id
        );

        try {
          await VectorDb["delete-namespace"]({ namespace: slug });
        } catch (e) {
          console.error(e.message);
        }
        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspaces",
    // T-4a (#25): NOT org-wide workspace.read — that is an admin capability and
    // no ordinary member holds it. This lists the workspaces the caller already
    // belongs to; membership does the filtering in the handler, so the gate only
    // has to establish that the caller is a real principal of this org.
    [validatedRequest, requirePermission("chat.send", orgResource)],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspaces = multiUserMode(response)
          ? await Workspace.whereWithUser(user)
          : await Workspace.where();

        response.status(200).json({ workspaces });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug",
    [validatedRequest, requirePermission("workspace.read", workspaceBySlug)],
    async (request, response) => {
      try {
        const { slug } = request.params;
        // Authorized above, so the plain lookup is correct here: membership is no
        // longer what decides access, it is only what the engine reads.
        const workspace = await Workspace.get({ slug });

        response.status(200).json({ workspace });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/chats",
    [validatedRequest, requirePermission("chat.read", workspaceBySlug)],
    async (request, response) => {
      try {
        const { slug } = request.params;
        const user = await userFromSession(request, response);
        const workspace = await Workspace.get({ slug });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const history = multiUserMode(response)
          ? await WorkspaceChats.forWorkspaceByUser(workspace.id, user.id)
          : await WorkspaceChats.forWorkspace(workspace.id);
        response.status(200).json({ history: convertToChatHistory(history) });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  // V9 (#61): search a user's OWN chat history inside one workspace.
  //
  // The gate is byte-identical to the two history reads above — same action, same
  // resolver — so concealment, key binding and the impersonation rule come from
  // the engine rather than from anything decided here. What this route adds is
  // input validation; the row-level `user_id` predicate is the model's, and it is
  // not optional there.
  app.get(
    "/workspace/:slug/chats/search",
    [
      validatedRequest,
      chatSearchRateLimit,
      requirePermission("chat.read", workspaceBySlug),
    ],
    async (request, response) => {
      try {
        const workspace = await Workspace.get({ slug: request.params.slug });
        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const query = String(request.query?.q ?? "").trim();
        if (
          query.length < MIN_SEARCH_LENGTH ||
          query.length > MAX_SEARCH_LENGTH
        ) {
          response.status(400).json({
            error: `Search query must be between ${MIN_SEARCH_LENGTH} and ${MAX_SEARCH_LENGTH} characters.`,
          });
          return;
        }

        // A cursor that is not a positive integer is a malformed request, not a
        // request for page one — silently starting over would hand the caller a
        // duplicate page and look like the cursor worked.
        const rawCursor = request.query?.cursor;
        let beforeId = null;
        if (rawCursor !== undefined && rawCursor !== "") {
          beforeId = Number(rawCursor);
          if (!Number.isInteger(beforeId) || beforeId <= 0) {
            response.status(400).json({ error: "Invalid cursor." });
            return;
          }
        }

        // The searching user, never a user named in the request. `chat.read_others`
        // does not widen this: V9 is the caller's own history (V10 owns cross-user
        // search and the leak tests that go with it).
        const user = await userFromSession(request, response);
        if (!user?.id) {
          response.sendStatus(401).end();
          return;
        }

        const chats = await WorkspaceChats.searchForUser({
          workspaceId: workspace.id,
          userId: user.id,
          query,
          limit: SEARCH_PAGE_SIZE,
          beforeId,
        });

        // thread_id carries no relation by design (schema comment: adding one
        // forces a whole-table migration), so slugs come from one extra lookup
        // over the distinct ids on this page rather than from a join.
        const threadIds = [
          ...new Set(chats.map((chat) => chat.thread_id).filter(Boolean)),
        ];
        const threads = threadIds.length
          ? await WorkspaceThread.where({ id: { in: threadIds } })
          : [];
        const slugByThreadId = new Map(
          threads.map((thread) => [thread.id, thread.slug])
        );

        const results = chats.map((chat) => ({
          chatId: chat.id,
          prompt: chat.prompt,
          response: chat.response_text,
          threadSlug: chat.thread_id
            ? (slugByThreadId.get(chat.thread_id) ?? null)
            : null,
          sentAt: Math.floor(new Date(chat.createdAt).getTime() / 1000),
        }));

        response.status(200).json({
          results,
          // Only a full page can have more behind it; a short page ends the walk
          // without costing the caller a request that returns nothing.
          nextCursor:
            results.length === SEARCH_PAGE_SIZE
              ? results[results.length - 1].chatId
              : null,
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/delete-chats",
    [
      validatedRequest,
      requirePermission("chat.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { chatIds = [] } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;

        if (!workspace || !Array.isArray(chatIds)) {
          response.sendStatus(400).end();
          return;
        }

        // This works for both workspace and threads.
        // we simplify this by just looking at workspace<>user overlap
        // since they are all on the same table.
        await WorkspaceChats.delete({
          id: { in: chatIds.map((id) => Number(id)) },
          user_id: user?.id ?? null,
          workspaceId: workspace.id,
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/delete-edited-chats",
    [
      validatedRequest,
      requirePermission("chat.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { startingId } = reqBody(request);
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;

        await WorkspaceChats.delete({
          workspaceId: workspace.id,
          thread_id: null,
          user_id: user?.id,
          id: { gte: Number(startingId) },
        });

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/update-chat",
    [
      validatedRequest,
      requirePermission("chat.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { chatId, newText = null, role = "assistant" } = reqBody(request);
        if (!newText || !String(newText).trim())
          throw new Error("Cannot save empty edit");

        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const existingChat = await WorkspaceChats.get({
          workspaceId: workspace.id,
          thread_id: null,
          user_id: user?.id,
          id: Number(chatId),
        });
        if (!existingChat) throw new Error("Invalid chat.");

        if (role === "user") {
          await WorkspaceChats._update(existingChat.id, {
            prompt: String(newText),
          });
        } else {
          const chatResponse = safeJsonParse(existingChat.response, null);
          if (!chatResponse) throw new Error("Failed to parse chat response");
          await WorkspaceChats._update(existingChat.id, {
            response: JSON.stringify({
              ...chatResponse,
              text: String(newText),
            }),
          });
        }

        response.sendStatus(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/workspace/:slug/chat-feedback/:chatId",
    [
      validatedRequest,
      requirePermission("chat.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { chatId } = request.params;
        const { feedback = null } = reqBody(request);
        const user = await userFromSession(request, response);
        const existingChat = await WorkspaceChats.get({
          id: Number(chatId),
          workspaceId: response.locals.workspace.id,
          user_id: user?.id,
        });

        if (!existingChat) return response.status(404).json({ success: false });
        await WorkspaceChats.updateFeedbackScore(chatId, feedback);
        return response.status(200).json({ success: true });
      } catch (error) {
        console.error("Error updating chat feedback:", error);
        response.status(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/suggested-messages",
    [
      validatedRequest,
      requirePermission("workspace.read", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async function (request, response) {
      try {
        const { slug } = request.params;
        const suggestedMessages =
          await WorkspaceSuggestedMessages.getMessages(slug);
        response.status(200).json({ success: true, suggestedMessages });
      } catch (error) {
        console.error("Error fetching suggested messages:", error);
        response
          .status(500)
          .json({ success: false, message: "Internal server error" });
      }
    }
  );

  app.post(
    "/workspace/:slug/suggested-messages",
    [validatedRequest, requirePermission("workspace.write", workspaceBySlug)],
    async (request, response) => {
      try {
        const { messages = [] } = reqBody(request);
        const { slug } = request.params;
        if (!Array.isArray(messages)) {
          return response.status(400).json({
            success: false,
            message: "Invalid message format. Expected an array of messages.",
          });
        }

        await WorkspaceSuggestedMessages.saveAll(messages, slug);
        return response.status(200).json({
          success: true,
          message: "Suggested messages saved successfully.",
        });
      } catch (error) {
        console.error("Error processing the suggested messages:", error);
        response.status(500).json({
          success: true,
          message: "Error saving the suggested messages.",
        });
      }
    }
  );

  app.post(
    "/workspace/:slug/update-pin",
    [
      validatedRequest,
      requirePermission("document.pin", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { docPath, pinStatus = false } = reqBody(request);
        const workspace = response.locals.workspace;

        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document) return response.sendStatus(404).end();

        await Document.update(document.id, { pinned: pinStatus });
        return response.status(200).end();
      } catch (error) {
        console.error("Error processing the pin status update:", error);
        return response.status(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/tts/:chatId",
    [
      validatedRequest,
      requirePermission("chat.read", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async function (request, response) {
      try {
        const { chatId } = request.params;
        const workspace = response.locals.workspace;
        const user = await userFromSession(request, response);
        const cacheKey = `${workspace.slug}:${chatId}`;
        const wsChat = await WorkspaceChats.get({
          id: Number(chatId),
          workspaceId: workspace.id,
          user_id: user?.id,
        });

        if (!wsChat) return response.sendStatus(404);
        const cachedResponse = responseCache.get(cacheKey);
        if (cachedResponse) {
          response.writeHead(200, {
            "Content-Type": cachedResponse.mime || "audio/mpeg",
          });
          response.end(cachedResponse.buffer);
          return;
        }

        const text = safeJsonParse(wsChat.response, null)?.text;
        if (!text) return response.sendStatus(204).end();

        const TTSProvider = getTTSProvider();
        const buffer = await TTSProvider.ttsBuffer(text);
        if (buffer === null) return response.sendStatus(204).end();

        const { mime } = getAudioFileInfo(buffer);
        responseCache.set(cacheKey, { buffer, mime });
        response.writeHead(200, {
          "Content-Type": mime,
        });
        response.end(buffer);
        return;
      } catch (error) {
        console.error("Error processing the TTS request:", error);
        response.status(500).json({ message: "TTS could not be completed" });
      }
    }
  );

  app.post(
    "/workspace/:slug/thread/fork",
    [
      validatedRequest,
      requirePermission("chat.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const user = await userFromSession(request, response);
        const workspace = response.locals.workspace;
        const { chatId, threadSlug } = reqBody(request);
        if (!chatId)
          return response.status(400).json({ message: "chatId is required" });

        // Get threadId we are branching from if that request body is sent
        // and is a valid thread slug.
        const threadId = !!threadSlug
          ? (
              await WorkspaceThread.get({
                slug: String(threadSlug),
                workspace_id: workspace.id,
              })
            )?.id ?? null
          : null;
        const chatsToFork = await WorkspaceChats.where(
          {
            workspaceId: workspace.id,
            user_id: user?.id,
            include: true, // only duplicate visible chats
            thread_id: threadId,
            api_session_id: null, // Do not include API session chats.
            id: { lte: Number(chatId) },
          },
          null,
          { id: "asc" }
        );

        const { thread: newThread, message: threadError } =
          await WorkspaceThread.new(workspace, user?.id);
        if (threadError)
          return response.status(500).json({ error: threadError });

        let lastMessageText = "";
        const chatsData = chatsToFork.map((chat) => {
          const chatResponse = safeJsonParse(chat.response, {});
          if (chatResponse?.text)
            lastMessageText = stripThinkingFromText(chatResponse.text);

          return {
            workspaceId: workspace.id,
            prompt: chat.prompt,
            response: JSON.stringify(chatResponse),
            user_id: user?.id,
            thread_id: newThread.id,
          };
        });
        await WorkspaceChats.bulkCreate(chatsData);
        await WorkspaceThread.update(newThread, {
          name: !!lastMessageText
            ? truncate(lastMessageText, 22)
            : "Forked Thread",
        });

        await emitAuditEvent(
          "thread_forked",
          {
            workspaceName: workspace?.name || "Unknown Workspace",
            threadName: newThread.name,
          },
          user?.id
        );
        response.status(200).json({ newThreadSlug: newThread.slug });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ message: "Internal server error" });
      }
    }
  );

  app.put(
    "/workspace/workspace-chats/:id",
    [validatedRequest, requirePermission("chat.send", chatByIdParam("id"))],
    async (request, response) => {
      try {
        const { id } = request.params;
        const user = await userFromSession(request, response);
        // Ownership still applies on top of the workspace decision: the engine
        // says whether the caller may act in that workspace at all, this says the
        // chat is theirs. Before T-4a only the second half existed, so owning a
        // chat survived losing access to the workspace holding it (S-3).
        const validChat = await WorkspaceChats.get({
          id: Number(id),
          user_id: user?.id ?? null,
        });
        if (!validChat)
          return response
            .status(404)
            .json({ success: false, error: "Chat not found." });

        await WorkspaceChats._update(validChat.id, { include: false });
        response.json({ success: true, error: null });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ success: false, error: "Server error" });
      }
    }
  );

  /** Handles the uploading and embedding in one-call by uploading via drag-and-drop in chat container. */
  app.post(
    "/workspace/:slug/upload-and-embed",
    [
      validatedRequest,
      requirePermission("document.create", workspaceBySlug),
      handleFileUpload,
    ],
    async function (request, response) {
      try {
        const { slug = null } = request.params;
        const user = await userFromSession(request, response);
        const currWorkspace = await Workspace.get({ slug });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        const Collector = new CollectorApi();
        const { originalname } = request.file;
        const processingOnline = await Collector.online();

        if (!processingOnline) {
          response
            .status(500)
            .json({
              success: false,
              error: `Document processing API is not online. Document ${originalname} will not be processed automatically.`,
            })
            .end();
          return;
        }

        const { success, reason, documents } =
          await Collector.processDocument(originalname);
        if (!success || documents?.length === 0) {
          response.status(500).json({ success: false, error: reason }).end();
          return;
        }

        Collector.log(
          `Document ${originalname} uploaded processed and successfully. It is now available in documents.`
        );
        await Telemetry.sendTelemetry("document_uploaded");
        await emitAuditEvent(
          "document_uploaded",
          {
            documentName: originalname,
          },
          response.locals?.user?.id
        );

        const document = documents[0];
        const { failedToEmbed = [], errors = [] } = await Document.addDocuments(
          currWorkspace,
          [document.location],
          response.locals?.user?.id
        );

        if (failedToEmbed.length > 0)
          return response
            .status(200)
            .json({ success: false, error: errors?.[0], document: null });

        response.status(200).json({
          success: true,
          error: null,
          document: { id: document.id, location: document.location },
        });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/remove-and-unembed",
    [
      validatedRequest,
      // Body first: the resolver reads documentLocation, and the whole point of
      // G11 is that the document is found in the ADDRESSED workspace rather than
      // taken on the caller's word.
      handleFileUpload,
      requirePermission("document.delete", documentInWorkspaceBySlug),
    ],
    async function (request, response) {
      try {
        const { slug = null } = request.params;
        const body = reqBody(request);
        const user = await userFromSession(request, response);
        const currWorkspace = await Workspace.get({ slug });

        if (!currWorkspace || !body.documentLocation)
          return response.sendStatus(400).end();

        // Still enforced on top of the grant: purgeDocument deletes system-wide,
        // so a caller authorized for THIS workspace must not take out copies
        // living in workspaces they hold nothing on. The guard's own legacy
        // legacy admin-role shortcut is gone — being an admin is now an
        // org-wide grant the engine checked above, not a string on the row.
        // The gate above said the caller may delete IN this workspace. Purging is
        // system-wide, so ask separately whether they may delete anywhere — that
        // org-wide grant is what the legacy admin role string stood for.
        const orgWide = await authorizationEngine.authorize({
          actor: response.locals.actor,
          action: "document.delete",
          resource: { type: "document", id: null, orgId: 1, workspaceId: null },
        });

        const { allowed, reason } = await canPurgeDocumentFromWorkspace({
          workspace: currWorkspace,
          user,
          documentLocation: body.documentLocation,
          orgWideDocumentDelete: orgWide.allowed,
        });
        if (!allowed) return response.status(403).json({ error: reason });

        // Will delete the document from the entire system + wil unembed it.
        await purgeDocument(body.documentLocation);
        response.status(200).end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/workspace/:slug/prompt-history",
    [
      validatedRequest,
      requirePermission("workspace.read", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (_, response) => {
      try {
        response.status(200).json({
          history: await Workspace.promptHistory({
            workspaceId: response.locals.workspace.id,
          }),
        });
      } catch (error) {
        console.error("Error fetching prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/prompt-history",
    [
      validatedRequest,
      requirePermission("workspace.write", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (_, response) => {
      try {
        response.status(200).json({
          success: await Workspace.deleteAllPromptHistory({
            workspaceId: response.locals.workspace.id,
          }),
        });
      } catch (error) {
        console.error("Error clearing prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  app.delete(
    "/workspace/prompt-history/:id",
    [
      validatedRequest,
      requirePermission("workspace.write", promptHistoryByIdParam("id")),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const { id } = request.params;
        response.status(200).json({
          success: await Workspace.deletePromptHistory({
            workspaceId: response.locals.workspace.id,
            id: Number(id),
          }),
        });
      } catch (error) {
        console.error("Error deleting prompt history:", error);
        response.sendStatus(500).end();
      }
    }
  );

  /**
   * Searches for workspaces and threads by thread name or workspace name.
   * Only returns assets owned by the user (if multi-user mode is enabled).
   */
  app.post(
    "/workspace/search",
    // Same as GET /workspaces: results are scoped to the caller inside
    // searchWorkspaceAndThreads, not by this gate.
    [validatedRequest, requirePermission("chat.send", orgResource)],
    async (request, response) => {
      try {
        const { searchTerm } = reqBody(request);
        const searchResults = await searchWorkspaceAndThreads(
          searchTerm,
          response.locals?.user
        );
        response.status(200).json(searchResults);
      } catch (error) {
        console.error("Error searching for workspaces:", error);
        response.sendStatus(500).end();
      }
    }
  );

  // SSE endpoint for embedding progress
  app.get(
    "/workspace/:slug/embed-progress",
    [
      validatedRequest,
      requirePermission("workspace.embeddings.manage", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const {
          addSSEConnection,
          removeSSEConnection,
        } = require("../utils/EmbeddingWorkerManager");

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();
        addSSEConnection(workspace.slug, response);
        request.on("close", () => {
          removeSSEConnection(workspace.slug, response);
        });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).end();
      }
    }
  );

  app.delete(
    "/workspace/:slug/embed-queue",
    [
      validatedRequest,
      requirePermission("workspace.embeddings.manage", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (request, response) => {
      try {
        const workspace = response.locals.workspace;
        const { filename } = reqBody(request);
        if (!filename) {
          response
            .status(400)
            .json({ success: false, error: "Missing filename" });
          return;
        }

        const { removeQueuedFile } = require("../utils/EmbeddingWorkerManager");
        const sent = removeQueuedFile(workspace.slug, filename);
        response.status(200).json({ success: sent });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({ success: false, error: e.message });
      }
    }
  );

  app.get(
    "/workspace/:slug/is-agent-command-available",
    [
      validatedRequest,
      requirePermission("workspace.read", workspaceBySlug),
      validWorkspaceSlug,
    ],
    async (_, response) => {
      try {
        response.status(200).json({
          showAgentCommand: await Workspace.isAgentCommandAvailable(
            response.locals.workspace
          ),
        });
      } catch (error) {
        console.error("Error checking if agent command is available:", error);
        response.status(500).json({ showAgentCommand: true });
      }
    }
  );

  // Parsed Files in separate endpoint just to keep the workspace endpoints clean
  workspaceParsedFilesEndpoints(app);
}

module.exports = { workspaceEndpoints };
