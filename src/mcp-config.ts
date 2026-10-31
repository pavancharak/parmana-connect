import { ConfigError } from "./config.js";

export interface McpConfig {
  readonly parmanaUrl: string;
  readonly apiKey: string;
  readonly authorityId: string;
  readonly authorityType: "USER" | "ROLE" | "SERVICE" | "ORGANIZATION";
  readonly principalId: string;
  readonly authorizationId: string;
  readonly purpose: string;
  readonly sourceSystem: string;
  readonly submittedBy: string;
  readonly manifestPath: string;
}

/** The HTTP entry point's settings: the stdio settings, plus the endpoint's own. */
export interface McpHttpConfig extends McpConfig {
  /** Shared secret an MCP client presents as a bearer token. Never logged. */
  readonly bearerToken: string;
  readonly host: string;
  readonly port: number;
}

const AUTHORITY_TYPES = ["USER", "ROLE", "SERVICE", "ORGANIZATION"] as const;
const MIN_TOKEN_LENGTH = 32;

/**
 * Reads the MCP server's settings from the environment. It refuses an
 * unencrypted Parmana URL, because the key would travel in clear text.
 */
export function loadMcpConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
  const parmanaUrl = required(env, "PARMANA_API_URL");
  let url: URL;
  try {
    url = new URL(parmanaUrl);
  } catch {
    throw new ConfigError("PARMANA_API_URL must be an absolute URL");
  }
  if (url.protocol !== "https:") {
    throw new ConfigError("PARMANA_API_URL must use https://");
  }

  const authorityType = required(env, "PARMANA_AUTHORITY_TYPE");
  if (!(AUTHORITY_TYPES as readonly string[]).includes(authorityType)) {
    throw new ConfigError("PARMANA_AUTHORITY_TYPE must be USER, ROLE, SERVICE or ORGANIZATION");
  }

  const principalId = required(env, "PARMANA_PRINCIPAL_ID");
  return {
    parmanaUrl,
    apiKey: required(env, "PARMANA_API_KEY"),
    authorityId: required(env, "PARMANA_AUTHORITY_ID"),
    authorityType: authorityType as McpConfig["authorityType"],
    principalId,
    authorizationId: required(env, "PARMANA_AUTHORIZATION_ID"),
    purpose: required(env, "PARMANA_AUTHORIZATION_PURPOSE"),
    sourceSystem: env.PARMANA_SOURCE_SYSTEM ?? "parmana-connect",
    submittedBy: env.PARMANA_SUBMITTED_BY ?? principalId,
    manifestPath: required(env, "PARMANA_CONNECTOR_MANIFEST"),
  };
}

/**
 * Reads the HTTP entry point's settings. The endpoint itself listens on plain
 * HTTP, so it must sit behind an HTTPS terminator; it refuses to start without
 * a bearer token of at least 32 characters.
 */
export function loadMcpHttpConfig(env: Readonly<Record<string, string | undefined>>): McpHttpConfig {
  const base = loadMcpConfig(env);

  const bearerToken = required(env, "PARMANA_MCP_BEARER_TOKEN");
  if (bearerToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`PARMANA_MCP_BEARER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  const portText = env.PARMANA_MCP_PORT ?? "8081";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PARMANA_MCP_PORT must be an integer from 1 to 65535");
  }

  return { ...base, bearerToken, host: env.PARMANA_MCP_HOST ?? "127.0.0.1", port };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}
