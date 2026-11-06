import { createMcpServer } from "./mcp-server.js";
import { loadMcpHttpConfig } from "./mcp-config.js";
import { createMcpHttpServer, MCP_PATH } from "./mcp-http.js";
import { loadMcpDeps } from "./mcp-setup.js";

/**
 * Starts the MCP server over streamable HTTP, for a remote agent such as a
 * Managed Agents session. Put it behind HTTPS. It exits with a message on
 * stderr if a setting is missing or invalid.
 */
async function main(): Promise<void> {
  const config = loadMcpHttpConfig(process.env);
  const deps = loadMcpDeps(config);

  const http = createMcpHttpServer({
    bearerToken: config.bearerToken,
    createMcpServer: () => createMcpServer(deps.manifest, deps.ctx),
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, resolve);
  });
  console.error(`parmana-connect MCP server listening on ${config.host}:${config.port}${MCP_PATH}`);
}

main().catch((err: unknown) => {
  // Log the reason, never a secret: configuration errors name a variable, not its value.
  console.error(`MCP HTTP server did not start: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
