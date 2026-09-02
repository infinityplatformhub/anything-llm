const { scopeFor } = require("../../../utils/apiKeySecurity/scopes");
const { emitAuditEvent } = require("../../../utils/events");
const { v4: uuidv4 } = require("uuid");
const { Document } = require("../../../models/documents");
const { Telemetry } = require("../../../models/telemetry");
const { DocumentVectors } = require("../../../models/vectors");
const { Workspace } = require("../../../models/workspace");
const { WorkspaceChats } = require("../../../models/workspaceChats");
const {
  resolveActor,
} = require("../../../utils/authorization/actorResolver");
const {
  authorizedSimilaritySearch,
} = require("../../../utils/authorization/retrievalFilter");
const {
  buildVectorSearchResponse,
} = require("../../../utils/authorization/cardinality");
const {
  getVectorDbClass,
  resolveProviderConnector,
} = require("../../../utils/helpers");
const { multiUserMode, reqBody } = require("../../../utils/http");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const { VALID_CHAT_MODE } = require("../../../utils/chats/stream");
const {
  convertToChatHistory,
  writeResponseChunk,
} = require("../../../utils/helpers/chat/responses");
const { ApiChatHandler } = require("../../../utils/chats/apiChatHandler");
const { getModelTag } = require("../../utils");
const {
  workspaceDeletionProtection,
} = require("../../../utils/middleware/workspaceDeletionProtection");

function apiWorkspaceEndpoints(app) {
  if (!app) return;

  app.post("/v1/workspace/new", [validApiKey(scopeFor("POST", "/v1/workspace/new"))], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Create a new workspace'
    #swagger.requestBody = {
      description: 'JSON object containing workspace configuration.',
      required: true,
      content: {
        "application/json": {
          example: {
            name: "My New Workspace",
            similarityThreshold: 0.7,
            openAiTemp: 0.7,
            openAiHistory: 20,
            openAiPrompt: "Custom prompt for responses",
            queryRefusalResponse: "Custom refusal message",
            chatMode: "chat",
            topN: 4
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
              workspace: {
                "id": 79,
                "name": "Sample workspace",
                "slug": "sample-workspace",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null
              },
              message: 'Workspace created'
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
      // A key issued for one workspace has no standing to mint another. Creation has
      // no workspace in the path, so the binding middleware cannot refuse this one.
      if (response.locals.apiKeyContext?.workspaceId) {
        return response.status(403).json({ error: "Insufficient scope." });
      }

      const { name = null, ...additionalFields } = reqBody(request);
      const { workspace, message } = await Workspace.new(
        name,
        null,
        additionalFields
      );

      if (!workspace) {
        response.status(400).json({ workspace: null, message });
        return;
      }

      await Telemetry.sendTelemetry("workspace_created", {
        multiUserMode: multiUserMode(response),
        LLMSelection: process.env.LLM_PROVIDER || "openai",
        Embedder: process.env.EMBEDDING_ENGINE || "inherit",
        VectorDbSelection: process.env.VECTOR_DB || "lancedb",
        TTSSelection: process.env.TTS_PROVIDER || "native",
        LLMModel: getModelTag(),
      });
      await emitAuditEvent("api_workspace_created", {
        workspaceName: workspace?.name || "Unknown Workspace",
      });
      response.status(200).json({ workspace, message });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/workspaces", [validApiKey(scopeFor("GET", "/v1/workspaces"))], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'List all current workspaces'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspaces: [
                {
                  "id": 79,
                  "name": "Sample workspace",
                  "slug": "sample-workspace",
                  "createdAt": "2023-08-17 00:45:03",
                  "openAiTemp": null,
                  "lastUpdatedAt": "2023-08-17 00:45:03",
                  "openAiHistory": 20,
                  "openAiPrompt": null,
                  "threads": []
                }
              ],
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
      // A workspace-bound key must not learn that the other workspaces exist. The
      // scope check cannot do this one: there is no workspace in the path to bind
      // against, so the narrowing has to happen where the query is built.
      const boundWorkspaceId = response.locals.apiKeyContext?.workspaceId;
      const workspaces = await Workspace._findMany({
        where: boundWorkspaceId ? { id: Number(boundWorkspaceId) } : {},
        include: {
          threads: {
            select: {
              user_id: true,
              slug: true,
              name: true,
            },
          },
        },
      });
      response.status(200).json({ workspaces });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/workspace/:slug", [validApiKey(scopeFor("GET", "/v1/workspace/:slug"), { workspaceSlugParam: "slug" })], async (request, response) => {
    /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Get a workspace by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              workspace: [
                {
                  "id": 79,
                  "name": "My workspace",
                  "slug": "my-workspace-123",
                  "createdAt": "2023-08-17 00:45:03",
                  "openAiTemp": null,
                  "lastUpdatedAt": "2023-08-17 00:45:03",
                  "openAiHistory": 20,
                  "openAiPrompt": null,
                  "documents": [],
                  "threads": []
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
    */
    try {
      const { slug } = request.params;
      const workspace = await Workspace._findMany({
        where: {
          slug: String(slug),
        },
        include: {
          documents: true,
          threads: {
            select: {
              user_id: true,
              slug: true,
            },
          },
        },
      });

      response.status(200).json({ workspace });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.delete(
    "/v1/workspace/:slug",
    [validApiKey(scopeFor("DELETE", "/v1/workspace/:slug"), { workspaceSlugParam: "slug" }), workspaceDeletionProtection],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Deletes a workspace by its slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to delete',
        required: true,
        type: 'string'
    }
    #swagger.responses[403] = {
      schema: {
        "$ref": "#/definitions/InvalidAPIKey"
      }
    }
    */
      try {
        const { slug = "" } = request.params;
        const VectorDb = getVectorDbClass();
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const workspaceId = Number(workspace.id);
        await WorkspaceChats.delete({ workspaceId: workspaceId });
        await DocumentVectors.deleteForWorkspace(workspaceId);
        await Document.delete({ workspaceId: workspaceId });
        await Workspace.delete({ id: workspaceId });

        await emitAuditEvent("api_workspace_deleted", {
          workspaceName: workspace?.name || "Unknown Workspace",
        });
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

  app.post(
    "/v1/workspace/:slug/update",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/update"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Update workspace settings by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'JSON object containing new settings to update a workspace. All keys are optional and will not update unless provided',
      required: true,
      content: {
        "application/json": {
          example: {
            "name": 'Updated Workspace Name',
            "openAiTemp": 0.2,
            "openAiHistory": 20,
            "openAiPrompt": "Respond to all inquires and questions in binary - do not respond in any other format."
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
              workspace: {
                "id": 79,
                "name": "My workspace",
                "slug": "my-workspace-123",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null,
                "documents": []
              },
              message: null,
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
        const { slug = null } = request.params;
        const data = reqBody(request);
        const currWorkspace = await Workspace.get({ slug: String(slug) });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        const { workspace, message } = await Workspace.update(
          currWorkspace.id,
          data
        );

        if (!workspace)
          return response.status(500).json({ workspace: null, message });
        return response.status(200).json({ workspace, message });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/workspace/:slug/chats",
    [validApiKey(scopeFor("GET", "/v1/workspace/:slug/chats"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Get a workspaces chats regardless of user by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.parameters['apiSessionId'] = {
        in: 'query',
        description: 'Optional apiSessionId to filter by',
        required: false,
        type: 'string'
    }
    #swagger.parameters['limit'] = {
        in: 'query',
        description: 'Optional number of chat messages to return (default: 100)',
        required: false,
        type: 'integer'
    }
    #swagger.parameters['orderBy'] = {
        in: 'query',
        description: 'Optional order of chat messages (asc or desc)',
        required: false,
        type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
              history: [
                {
                  "role": "user",
                  "content": "What is ApproofWorkspace?",
                  "sentAt": 1692851630
                },
                {
                  "role": "assistant",
                  "content": "ApproofWorkspace is a platform that allows you to convert notes, PDFs, and other source materials into a chatbot. It ensures privacy, cites its answers, and allows multiple people to interact with the same documents simultaneously. It is particularly useful for businesses to enhance the visibility and readability of various written communications such as SOPs, contracts, and sales calls. You can try it out with a free trial to see if it meets your business needs.",
                  "sources": [{"source": "object about source document and snippets used"}]
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
    */
      try {
        const { slug } = request.params;
        const {
          apiSessionId = null,
          limit = 100,
          orderBy = "asc",
        } = request.query;
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.sendStatus(400).end();
          return;
        }

        const validLimit = Math.max(1, parseInt(limit));
        const validOrderBy = ["asc", "desc"].includes(orderBy)
          ? orderBy
          : "asc";

        const history = apiSessionId
          ? await WorkspaceChats.forWorkspaceByApiSessionId(
              workspace.id,
              apiSessionId,
              validLimit,
              { createdAt: validOrderBy }
            )
          : await WorkspaceChats.forWorkspace(workspace.id, validLimit, {
              createdAt: validOrderBy,
            });
        response.status(200).json({ history: convertToChatHistory(history) });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/update-embeddings",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/update-embeddings"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Add or remove documents from a workspace by its unique slug.'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to find',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'JSON object of additions and removals of documents to add to update a workspace. The value should be the folder + filename with the exclusions of the top-level documents path.',
      required: true,
      content: {
        "application/json": {
          example: {
            adds: ["custom-documents/my-pdf.pdf-hash.json"],
            deletes: ["custom-documents/approofworkspace.txt-hash.json"]
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
              workspace: {
                "id": 79,
                "name": "My workspace",
                "slug": "my-workspace-123",
                "createdAt": "2023-08-17 00:45:03",
                "openAiTemp": null,
                "lastUpdatedAt": "2023-08-17 00:45:03",
                "openAiHistory": 20,
                "openAiPrompt": null,
                "documents": []
              },
              message: null,
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
        const { slug = null } = request.params;
        const { adds = [], deletes = [] } = reqBody(request);
        const currWorkspace = await Workspace.get({ slug: String(slug) });

        if (!currWorkspace) {
          response.sendStatus(400).end();
          return;
        }

        await Document.removeDocuments(currWorkspace, deletes);
        await Document.addDocuments(currWorkspace, adds);
        const updatedWorkspace = await Workspace.get({
          id: Number(currWorkspace.id),
        });
        response.status(200).json({ workspace: updatedWorkspace });
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/update-pin",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/update-pin"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
      #swagger.tags = ['Workspaces']
      #swagger.description = 'Add or remove pin from a document in a workspace by its unique slug.'
      #swagger.parameters['slug'] = {
          in: 'path',
          description: 'Unique slug of workspace to find',
          required: true,
          type: 'string'
      }
      #swagger.requestBody = {
        description: 'JSON object with the document path and pin status to update.',
        required: true,
        content: {
          "application/json": {
            example: {
              docPath: "custom-documents/my-pdf.pdf-hash.json",
              pinStatus: true
            }
          }
        }
      }
      #swagger.responses[200] = {
        description: 'OK',
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                message: 'Pin status updated successfully'
              }
            }
          }
        }
      }
      #swagger.responses[404] = {
        description: 'Document not found'
      }
      #swagger.responses[500] = {
        description: 'Internal Server Error'
      }
      */
      try {
        const { slug = null } = request.params;
        const { docPath, pinStatus = false } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        const document = await Document.get({
          workspaceId: workspace.id,
          docpath: docPath,
        });
        if (!document) return response.sendStatus(404).end();

        await Document.update(document.id, { pinned: pinStatus });
        return response
          .status(200)
          .json({ message: "Pin status updated successfully" })
          .end();
      } catch (error) {
        console.error("Error processing the pin status update:", error);
        return response.status(500).end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/chat",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/chat"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
   #swagger.tags = ['Workspaces']
   #swagger.description = 'Execute a chat with a workspace'
   #swagger.requestBody = {
       description: 'Send a prompt to the workspace and the type of conversation (automatic, query or chat).<br/><b>Query:</b> Will not use LLM unless there are relevant sources from vectorDB & does not recall chat history.<br/><b>Automatic:</b> Will use tool-calling if the provider supports native tool calling without needing to invoke @agent.<br/><b>Chat:</b> Uses LLM general knowledge w/custom embeddings to produce output, uses rolling chat history.<br/><b>Attachments:</b> Can include images and documents.<br/><b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Document attachments:</b> must have the mime type <code>application/anythingllm-document</code> - otherwise it will be passed to the LLM as an image and may fail to process. This uses the built-in document processor to first parse the document to text before injecting it into the context window.',
       required: true,
       content: {
         "application/json": {
           example: {
             message: "What is ApproofWorkspace?",
             mode:"automatic | query | chat",
             sessionId: "identifier-to-partition-chats-by-external-id",
             attachments: [
               {
                 name: "image.png",
                 mime: "image/png",
                 contentString: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               },
               {
                 name: "this is a document.pdf",
                 mime: "application/anythingllm-document",
                 contentString: "data:application/pdf;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               }
             ],
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
              id: 'chat-uuid',
              type: "abort | textResponse",
              textResponse: "Response to your query",
              sources: [{title: "approofworkspace.txt", chunk: "This is a context chunk used in the answer of the prompt by the LLM,"}],
              close: true,
              error: "null | text string of the failure mode."
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
        const { slug } = request.params;
        const {
          message,
          mode = null,
          sessionId = null,
          attachments = [],
          reset = false,
        } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `Workspace ${slug} is not a valid workspace.`,
          });
          return;
        }

        const resolvedMode = mode ?? workspace.chatMode;
        if (
          (!message?.length || !VALID_CHAT_MODE.includes(resolvedMode)) &&
          !reset
        ) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: !message?.length
              ? "Message is empty"
              : `${resolvedMode} is not a valid mode.`,
          });
          return;
        }

        const result = await ApiChatHandler.chatSync({
          workspace,
          message,
          mode: resolvedMode,
          user: null,
          // T-5 (#30): `user` is null on /v1 — the caller is an API key, and its identity
          // lives in the Actor (the key reads as its creator, narrowed by its scopes).
          // Retrieval is filtered by this; without it the request would have no principal
          // and read nothing.
          actor: await resolveActor(request, response),
          thread: null,
          sessionId: !!sessionId ? String(sessionId) : null,
          attachments,
          reset,
        });

        await Telemetry.sendTelemetry("sent_chat", {
          LLMSelection:
            workspace.chatProvider ?? process.env.LLM_PROVIDER ?? "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          TTSSelection: process.env.TTS_PROVIDER || "native",
        });
        await emitAuditEvent("api_sent_chat", {
          workspaceName: workspace?.name,
          chatModel: workspace?.chatModel || "System Default",
        });
        return response.status(200).json({ ...result });
      } catch (e) {
        console.error(e.message, e);
        response.status(500).json({
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/stream-chat",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/stream-chat"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
   #swagger.tags = ['Workspaces']
   #swagger.description = 'Execute a streamable chat with a workspace'
   #swagger.requestBody = {
       description: 'Send a prompt to the workspace and the type of conversation (automatic, query or chat).<br/><b>Query:</b> Will not use LLM unless there are relevant sources from vectorDB & does not recall chat history.<br/><b>Automatic:</b> Will use tool-calling if the provider supports native tool calling without needing to invoke @agent.<br/><b>Chat:</b> Uses LLM general knowledge w/custom embeddings to produce output, uses rolling chat history.<br/><b>Attachments:</b> Can include images and documents.<br/><b>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Document attachments:</b> must have the mime type <code>application/anythingllm-document</code> - otherwise it will be passed to the LLM as an image and may fail to process. This uses the built-in document processor to first parse the document to text before injecting it into the context window.',
       required: true,
       content: {
         "application/json": {
           example: {
             message: "What is ApproofWorkspace?",
             mode: "automatic | query | chat",
             sessionId: "identifier-to-partition-chats-by-external-id",
             attachments: [
               {
                 name: "image.png",
                 mime: "image/png",
                 contentString: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               },
               {
                 name: "this is a document.pdf",
                 mime: "application/anythingllm-document",
                 contentString: "data:application/pdf;base64,iVBORw0KGgoAAAANSUhEUgAA..."
               }
             ],
             reset: false
           }
         }
       }
     }
   #swagger.responses[200] = {
     content: {
       "text/event-stream": {
         schema: {
           type: 'array',
           items: {
              type: 'string',
          },
           example: [
            {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "First chunk",
              sources: [],
              close: false,
              error: "null | text string of the failure mode."
            },
            {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "chunk two",
              sources: [],
              close: false,
              error: "null | text string of the failure mode."
            },
             {
              id: 'uuid-123',
              type: "abort | textResponseChunk",
              textResponse: "final chunk of LLM output!",
              sources: [{title: "approofworkspace.txt", chunk: "This is a context chunk used in the answer of the prompt by the LLM. This will only return in the final chunk."}],
              close: true,
              error: "null | text string of the failure mode."
            }
          ]
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
        const { slug } = request.params;
        const {
          message,
          mode = null,
          sessionId = null,
          attachments = [],
          reset = false,
        } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `Workspace ${slug} is not a valid workspace.`,
          });
          return;
        }

        const resolvedMode = mode ?? workspace.chatMode;
        if (
          (!message?.length || !VALID_CHAT_MODE.includes(resolvedMode)) &&
          !reset
        ) {
          response.status(400).json({
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: !message?.length
              ? "Message is empty"
              : `${resolvedMode} is not a valid mode.`,
          });
          return;
        }

        response.setHeader("Cache-Control", "no-cache");
        response.setHeader("Content-Type", "text/event-stream");
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Connection", "keep-alive");
        response.flushHeaders();

        await ApiChatHandler.streamChat({
          response,
          workspace,
          message,
          mode: resolvedMode,
          user: null,
          // T-5 (#30): see chatSync above — the key's identity is the Actor, not `user`.
          actor: await resolveActor(request, response),
          thread: null,
          sessionId: !!sessionId ? String(sessionId) : null,
          attachments,
          reset,
        });
        await Telemetry.sendTelemetry("sent_chat", {
          LLMSelection:
            workspace.chatProvider ?? process.env.LLM_PROVIDER ?? "openai",
          Embedder: process.env.EMBEDDING_ENGINE || "inherit",
          VectorDbSelection: process.env.VECTOR_DB || "lancedb",
          TTSSelection: process.env.TTS_PROVIDER || "native",
        });
        await emitAuditEvent("api_sent_chat", {
          workspaceName: workspace?.name,
          chatModel: workspace?.chatModel || "System Default",
        });
        response.end();
      } catch (e) {
        console.error(e.message, e);
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: e.message,
        });
        response.end();
      }
    }
  );

  app.post(
    "/v1/workspace/:slug/vector-search",
    [validApiKey(scopeFor("POST", "/v1/workspace/:slug/vector-search"), { workspaceSlugParam: "slug" })],
    async (request, response) => {
      /*
    #swagger.tags = ['Workspaces']
    #swagger.description = 'Perform a vector similarity search in a workspace'
    #swagger.parameters['slug'] = {
        in: 'path',
        description: 'Unique slug of workspace to search in',
        required: true,
        type: 'string'
    }
    #swagger.requestBody = {
      description: 'Query to perform vector search with and optional parameters',
      required: true,
      content: {
        "application/json": {
          example: {
            query: "What is the meaning of life?",
            topN: 4,
            scoreThreshold: 0.75
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
              results: [
                {
                  id: "5a6bee0a-306c-47fc-942b-8ab9bf3899c4",
                  text: "Document chunk content...",
                  metadata: {
                    url: "file://document.txt",
                    title: "document.txt",
                    author: "no author specified",
                    description: "no description found",
                    docSource: "post:123456",
                    chunkSource: "document.txt",
                    published: "12/1/2024, 11:39:39 AM",
                    wordCount: 8,
                    tokenCount: 9
                  },
                  distance: 0.541887640953064,
                  score: 0.45811235904693604
                }
              ]
            }
          }
        }
      }
    }
    */
      try {
        const { slug } = request.params;
        const { query, topN, scoreThreshold } = reqBody(request);
        const workspace = await Workspace.get({ slug: String(slug) });

        if (!workspace)
          return response.status(400).json({
            message: `Workspace ${slug} is not a valid workspace.`,
          });

        if (!query?.length)
          return response.status(400).json({
            message: "Query parameter cannot be empty.",
          });

        const VectorDb = getVectorDbClass();
        // T-5 (#30) slice 3 (S-25): the `namespaceCount === 0` early return used to answer
        // with a DIFFERENT body — `{results: [], message: "No embeddings found..."}` —
        // than an ACL-filtered search that matched nothing, which answers `{results: []}`.
        // That made "this workspace holds content you may not read" distinguishable from
        // "this workspace is empty": an existence oracle over workspace content, the same
        // class as #32's mint oracle.
        //
        // The check is gone rather than made to match. An empty namespace already flows
        // through the search path and returns the same empty shape, so the early return
        // bought nothing except the leak. Costing one embedding call on an empty workspace
        // is the price of having one code path instead of two.

        const parseSimilarityThreshold = () => {
          let input = parseFloat(scoreThreshold);
          if (isNaN(input) || input < 0 || input > 1)
            return workspace?.similarityThreshold ?? 0.25;
          return input;
        };

        const parseTopN = () => {
          let input = Number(topN);
          if (isNaN(input) || input < 1) return workspace?.topN ?? 4;
          return input;
        };

        const { connector: LLMConnector } = await resolveProviderConnector({
          workspace,
          prompt: String(query),
        });

        // T-5 (#30) S-11: the highest-value leak surface in the recon. This route hands
        // back raw chunk text rather than an LLM answer, so an unfiltered result is an
        // immediate verbatim leak with nothing in between to blur it.
        const results = await authorizedSimilaritySearch({
          VectorDb,
          actor: await resolveActor(request, response),
          namespace: workspace.slug,
          input: String(query),
          LLMConnector,
          similarityThreshold: parseSimilarityThreshold(),
          topN: parseTopN(),
          rerank: workspace?.vectorSearchMode === "rerank",
          query: String(query),
        });

        // One builder for every outcome, so an empty result is byte-identical whether the
        // namespace was empty or the ACL removed everything (S-25).
        response.status(200).json(buildVectorSearchResponse(results));
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { apiWorkspaceEndpoints };
