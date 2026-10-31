import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createMcpServer } from "./mcp-server.js";
import { loadMcpConfig } from "./mcp-config.js";
import { loadMcpDeps } from "./mcp-setup.js";

/**
 * Starts the MCP server on stdio, for an agent to launch. It exits with a
 * message on stderr if a setting is missing or invalid.
 */
async function main(): Promise<void> {
  const deps = loadMcpDeps(loadMcpConfig(process.env));
  const server = createMcpServer(deps.manifest, deps.ctx);
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // Log the reason, never a secret: configuration errors name a variable, not its value.
  console.error(`MCP server did not start: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
