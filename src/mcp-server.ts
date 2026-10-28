import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";

import { callTool, toolsFor, type ToolContext } from "./mcp-tools.js";
import { type Manifest } from "./manifest.js";
import { ParmanaUnavailableError } from "./parmana-client.js";

/**
 * An MCP server whose tools are the capabilities in a connector manifest. Each
 * call is sent to Parmana, which decides whether it may run.
 */
export function createMcpServer(manifest: Manifest, ctx: ToolContext): Server {
  const server = new Server(
    { name: `parmana-connect-${manifest.system}`, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(manifest).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: "object"; properties?: Record<string, object>; required?: string[] },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return (await callTool(manifest, ctx, request.params.name, request.params.arguments ?? {})) as CallToolResult;
    } catch (err) {
      // Say that the call did not complete. Never guess an outcome.
      const text = err instanceof ParmanaUnavailableError ? err.message : "The call could not be completed.";
      return { content: [{ type: "text", text: `${text} Nothing was retried.` }], isError: true } as CallToolResult;
    }
  });

  return server;
}
