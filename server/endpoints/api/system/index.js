const { scopeFor } = require("../../../utils/apiKeySecurity/scopes");
const { emitAuditEvent } = require("../../../utils/events");
const { SystemSettings } = require("../../../models/systemSettings");
const { purgeDocument } = require("../../../utils/files/purgeDocument");
const { getVectorDbClass } = require("../../../utils/helpers");
const {
  exportChatsAsType,
  validExportTypes,
} = require("../../../utils/helpers/chat/convertTo");
const { dumpENV, updateENV } = require("../../../utils/helpers/updateENV");
const { reqBody } = require("../../../utils/http");
const { validApiKey } = require("../../../utils/middleware/validApiKey");
const {
  resolveActor,
} = require("../../../utils/authorization/actorResolver");

function apiSystemEndpoints(app) {
  if (!app) return;

  app.get("/v1/system/env-dump", [validApiKey(scopeFor("GET", "/v1/system/env-dump"))], async (_, response) => {
    /*
   #swagger.tags = ['System Settings']
   #swagger.description = 'Dump all settings to file storage'
   #swagger.responses[403] = {
     schema: {
       "$ref": "#/definitions/InvalidAPIKey"
     }
   }
   */
    try {
      if (process.env.NODE_ENV !== "production")
        return response.sendStatus(200).end();
      dumpENV();
      response.sendStatus(200).end();
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/system", [validApiKey(scopeFor("GET", "/v1/system"))], async (_, response) => {
    /*
    #swagger.tags = ['System Settings']
    #swagger.description = 'Get all current system settings that are defined.'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
             "settings": {
                "VectorDB": "pinecone",
                "PineConeKey": true,
                "PineConeIndex": "my-pinecone-index",
                "LLMProvider": "azure",
                "[KEY_NAME]": "KEY_VALUE",
              }
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
      const settings = await SystemSettings.currentSettings();
      response.status(200).json({ settings });
    } catch (e) {
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.get("/v1/system/vector-count", [validApiKey(scopeFor("GET", "/v1/system/vector-count"))], async (request, response) => {
    /*
    #swagger.tags = ['System Settings']
    #swagger.description = 'Number of all vectors in connected vector database'
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: {
             "vectorCount": 5450
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
      // T-5 (#30) slice 3 (S-25): this returned the INSTANCE total to any valid key,
      // including one bound to a single workspace. A count is enough to answer "does this
      // instance hold data beyond what I can see", which is the question the ACL refuses.
      //
      // #67 A+B restated for counts: a bound key counts within its own scope; an org-wide
      // principal still gets the instance total. The response shape is unchanged —
      // `{vectorCount}`, one key — because a differently shaped answer would itself say
      // which kind of caller you are.
      const VectorDb = getVectorDbClass();
      const {
        scopedTotalVectors,
      } = require("../../../utils/authorization/cardinality");
      const {
        retrievalFilterFor,
      } = require("../../../utils/authorization/retrievalFilter");
      const { Workspace } = require("../../../models/workspace");

      const aclFilter = await retrievalFilterFor({
        actor: await resolveActor(request, response),
        action: "document.read",
      });
      const { vectorCount } = await scopedTotalVectors({
        VectorDb,
        aclFilter,
        countFor: async (workspaceId) => {
          const workspace = await Workspace.get({ id: Number(workspaceId) });
          if (!workspace) return 0;
          return VectorDb.namespaceCount(workspace.slug);
        },
      });
      response.status(200).json({ vectorCount });
    } catch (e) {
      // A scope too wide to count is a refusal an operator must SEE, not a truncated
      // number that looks correct. Distinguished from a genuine fault so the message can
      // say what happened.
      const {
        CardinalityScopeTooLargeError,
      } = require("../../../utils/authorization/cardinality");
      if (e instanceof CardinalityScopeTooLargeError) {
        console.error("[cardinality]", e.message);
        return response
          .status(500)
          .json({ error: "workspace scope too large to count" });
      }
      console.error(e.message, e);
      response.sendStatus(500).end();
    }
  });

  app.post(
    "/v1/system/update-env",
    [validApiKey(scopeFor("POST", "/v1/system/update-env"))],
    async (request, response) => {
      /*
      #swagger.tags = ['System Settings']
      #swagger.description = 'Update a system setting or preference.'
      #swagger.requestBody = {
        description: 'Key pair object that matches a valid setting and value. Get keys from GET /v1/system or refer to codebase.',
        required: true,
        content: {
          "application/json": {
            example: {
              VectorDB: "lancedb",
              AnotherKey: "updatedValue"
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
                newValues: {"[ENV_KEY]": 'Value'},
                error: 'error goes here, otherwise null'
              }
            }
          }
        }
      }
      #swagger.responses[400] = {
        description: 'Unknown environment keys. No settings are changed.'
      }
      #swagger.responses[500] = {
        description: 'A setting failed validation or could not be updated.'
      }
      #swagger.responses[403] = {
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      */
      try {
        const body = reqBody(request);
        const result = await updateENV(body);
        const status = result.code === "unknown_keys" ? 400 : result.error ? 500 : 200;
        response.status(status).json(result);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );

  app.get(
    "/v1/system/export-chats",
    [validApiKey(scopeFor("GET", "/v1/system/export-chats"))],
    async (request, response) => {
      /*
    #swagger.tags = ['System Settings']
    #swagger.description = 'Export all of the chats from the system in a known format. Output depends on the type sent. Will be send with the correct header for the output.'
   #swagger.parameters['type'] = {
      in: 'query',
      description: "Export format jsonl, json, csv, jsonAlpaca",
      required: false,
      type: 'string'
    }
    #swagger.responses[200] = {
      content: {
        "application/json": {
          schema: {
            type: 'object',
            example: [
              {
                "role": "user",
                "content": "What is ApproofWorkspace?"
              },
              {
                "role": "assistant",
                "content": "ApproofWorkspace is a knowledge graph and vector database management system built using NodeJS express server. It provides an interface for handling all interactions, including vectorDB management and LLM (Language Model) interactions."
              },
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
        const { type = "jsonl" } = request.query;
        if (!validExportTypes.includes(type)) {
          response.status(400).json({
            message: `Invalid export type: ${type}. Must be one of ${validExportTypes.join(", ")}`,
          });
          return;
        }

        const { contentType, data } = await exportChatsAsType(
          type,
          "workspace"
        );
        await emitAuditEvent("exported_chats", {
          type,
        });
        response.setHeader("Content-Type", contentType);
        response.status(200).send(data);
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
  app.delete(
    "/v1/system/remove-documents",
    [validApiKey(scopeFor("DELETE", "/v1/system/remove-documents"))],
    async (request, response) => {
      /*
      #swagger.tags = ['System Settings']
      #swagger.description = 'Permanently remove documents from the system.'
      #swagger.requestBody = {
        description: 'Array of document names to be removed permanently.',
        required: true,
        content: {
          "application/json": {
            schema: {
              type: 'object',
              properties: {
                names: {
                  type: 'array',
                  items: {
                    type: 'string'
                  },
                  example: [
                    "custom-documents/file.txt-fc4beeeb-e436-454d-8bb4-e5b8979cb48f.json"
                  ]
                }
              }
            }
          }
        }
      }
      #swagger.responses[200] = {
        description: 'Documents removed successfully.',
        content: {
          "application/json": {
            schema: {
              type: 'object',
              example: {
                success: true,
                message: 'Documents removed successfully'
              }
            }
          }
        }
      }
      #swagger.responses[403] = {
        description: 'Forbidden',
        schema: {
          "$ref": "#/definitions/InvalidAPIKey"
        }
      }
      #swagger.responses[500] = {
        description: 'Internal Server Error'
      }
      */
      try {
        // This purges documents system-wide by name; there is no workspace in the
        // path or body to bind against, so a workspace-bound key has no way to
        // express a purge limited to its own workspace. Refuse rather than let it
        // delete another tenant's documents.
        if (response.locals.apiKeyContext?.workspaceId) {
          return response.status(403).json({ error: "Insufficient scope." });
        }

        const { names } = reqBody(request);
        for await (const name of names) await purgeDocument(name);
        response
          .status(200)
          .json({ success: true, message: "Documents removed successfully" })
          .end();
      } catch (e) {
        console.error(e.message, e);
        response.sendStatus(500).end();
      }
    }
  );
}

module.exports = { apiSystemEndpoints };
