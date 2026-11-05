import { readFileSync } from "node:fs";

import { Pool } from "pg";

import { loadServiceConfig, ConfigError } from "./config.js";
import { createGenericConnector } from "./connector.js";
import { createExecutionService } from "./execution-service.js";
import { PostgresNonceStore } from "./postgres-nonce-store.js";

/**
 * Starts the execution service from environment variables. It exits with a
 * message, and a non-zero status, if any required setting is missing or invalid.
 */
async function main(): Promise<void> {
  const config = loadServiceConfig(process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
  });

  const connector = createGenericConnector(config.manifest);
  const nonceStore =
    config.nonceStore === "postgres" && config.databaseUrl !== undefined
      ? new PostgresNonceStore(new Pool({ connectionString: config.databaseUrl }))
      : undefined;
  const service = createExecutionService({
    bearerToken: config.bearerToken,
    releaseAudience: config.releaseAudience,
    releaseOnly: config.releaseOnly,
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
    nonceStore,
  });

  await service.listen(config.port, config.host);
  console.log(`execution service listening on port ${config.port}`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : "unknown error";
  console.error(`execution service did not start: ${message}`);
  process.exit(1);
});
