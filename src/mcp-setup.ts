import { readFileSync } from "node:fs";

import { ConfigError } from "./config.js";
import { type McpConfig } from "./mcp-config.js";
import { loadManifest, type Manifest } from "./manifest.js";
import { ParmanaClient } from "./parmana-client.js";
import { type ToolContext } from "./mcp-tools.js";

export interface McpDeps {
  readonly manifest: Manifest;
  readonly ctx: ToolContext;
}

/**
 * Reads the manifest and builds the context every tool call uses. Both the
 * stdio and the HTTP entry points start from this, so they behave the same.
 */
export function loadMcpDeps(config: McpConfig): McpDeps {
  const manifestResult = loadManifest(readFileSync(config.manifestPath, "utf8"));
  if (!manifestResult.ok) {
    throw new ConfigError("PARMANA_CONNECTOR_MANIFEST is invalid");
  }

  return {
    manifest: manifestResult.manifest,
    ctx: {
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
    },
  };
}
