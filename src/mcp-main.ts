import { readFileSync } from "node:fs";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { ConfigError } from "./config.js";
import { createMcpServer } from "./mcp-server.js";
import { loadMcpConfig } from "./mcp-config.js";
import { loadManifest } from "./manifest.js";
import { ParmanaClient } from "./parmana-client.js";

/**
 * Starts the MCP server on stdio, for an agent to launch. It exits with a
 * message on stderr if a setting is missing or invalid.
 */
async function main(): Promise<void> {
  const config = loadMcpConfig(process.env);
  const manifestResult = loadManifest(readFileSync(config.manifestPath, "utf8"));
  if (!manifestResult.ok) {
    throw new ConfigError("PARMANA_CONNECTOR_MANIFEST is invalid");
  }

  const server = createMcpServer(manifestResult.manifest, {
    parmana: new ParmanaClient({ baseUrl: config.parmanaUrl, apiKey: config.apiKey }),
    authority: {
      authorityId: config.authorityId,
      authorityType: config.authorityType,
      principalId: config.principalId,
    },
    authorizationId: config.authorizationId,
    purpose: config.purpose,
    sourceSystem: config.sourceSystem,
    submittedBy: config.submittedBy,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // Log the reason, never a secret: configuration errors name a variable, not its value.
  console.error(`MCP server did not start: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
