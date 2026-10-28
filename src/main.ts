import { readFileSync } from "node:fs";

import { loadServiceConfig, ConfigError } from "./config.js";
import { createGenericConnector } from "./connector.js";
import { createExecutionService } from "./execution-service.js";

/**
 * Starts the execution service from environment variables. It exits with a
 * message, and a non-zero status, if any required setting is missing or invalid.
 */
async function main(): Promise<void> {
  const config = loadServiceConfig(process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
  });

  const connector = createGenericConnector(config.manifest);
  const service = createExecutionService({
    bearerToken: config.bearerToken,
    publicKey: config.publicKey,
    connector,
    resolveCredential: () => {
      const value = process.env[config.credentialVariable];
      if (value === undefined || value === "") {
        throw new ConfigError(`${config.credentialVariable} is not set`);
      }
      return value;
    },
    credentialId: config.credentialVariable,
    timeoutMs: config.timeoutMs,
  });

  await service.listen(config.port);
  console.log(`execution service listening on port ${config.port}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error(`execution service did not start: ${message}`);
  process.exit(1);
});
