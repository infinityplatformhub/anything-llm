const { reqBody } = require("../utils/http");
const MCPCompatibilityLayer = require("../utils/MCP");
const { requirePermission } = require("../utils/middleware/requirePermission");
const { orgResource } = require("../utils/middleware/resourceResolvers");
const { validatedRequest } = require("../utils/middleware/validatedRequest");

function mcpServersEndpoints(app) {
  if (!app) return;

  app.get(
    "/mcp-servers/force-reload",
    [validatedRequest, requirePermission("mcp-server.write", orgResource)],
    async (_request, response) => {
      try {
        const mcp = new MCPCompatibilityLayer();
        await mcp.reloadMCPServers();
        return response.status(200).json({
          success: true,
          error: null,
          servers: await mcp.servers(),
        });
      } catch (error) {
        console.error("Error force reloading MCP servers:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
          servers: [],
        });
      }
    }
  );

  app.get(
    "/mcp-servers/list",
    [validatedRequest, requirePermission("mcp-server.read", orgResource)],
    async (_request, response) => {
      try {
        const servers = await new MCPCompatibilityLayer().servers();
        return response.status(200).json({
          success: true,
          servers,
        });
      } catch (error) {
        console.error("Error listing MCP servers:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/toggle",
    [validatedRequest, requirePermission("mcp-server.write", orgResource)],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const result = await new MCPCompatibilityLayer().toggleServerStatus(
          name
        );
        return response.status(200).json({
          success: result.success,
          error: result.error,
        });
      } catch (error) {
        console.error("Error toggling MCP server:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/delete",
    [validatedRequest, requirePermission("mcp-server.write", orgResource)],
    async (request, response) => {
      try {
        const { name } = reqBody(request);
        const result = await new MCPCompatibilityLayer().deleteServer(name);
        return response.status(200).json({
          success: result.success,
          error: result.error,
        });
      } catch (error) {
        console.error("Error deleting MCP server:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
        });
      }
    }
  );

  app.post(
    "/mcp-servers/toggle-tool",
    [validatedRequest, requirePermission("mcp-server.write", orgResource)],
    async (request, response) => {
      try {
        const { serverName, toolName, enabled } = reqBody(request);
        const result = await new MCPCompatibilityLayer().toggleToolSuppression(
          serverName,
          toolName,
          enabled
        );
        return response.status(200).json({
          success: result.success,
          error: result.error,
          suppressedTools: result.suppressedTools,
        });
      } catch (error) {
        console.error("Error toggling MCP tool:", error);
        return response.status(500).json({
          success: false,
          error: error.message,
          suppressedTools: [],
        });
      }
    }
  );
}

module.exports = { mcpServersEndpoints };
