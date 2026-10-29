import { createPublicKey, type KeyObject } from "node:crypto";

import { loadManifest, type Manifest } from "./manifest.js";

/**
 * Settings for running the execution service, read from the environment.
 * Every value is required unless it says otherwise. A missing or invalid
 * value stops startup with a message that names the variable, never the value.
 */
export interface ServiceConfig {
  readonly port: number;
  /** Address to bind. 127.0.0.1 unless PARMANA_SERVICE_HOST says otherwise. */
  readonly host: string;
  readonly bearerToken: string;
  readonly publicKey: KeyObject;
  readonly manifest: Manifest;
  /** Name of the environment variable that holds the upstream secret. */
  readonly credentialVariable: string;
  readonly timeoutMs: number;
  /** postgres: a database shared by every instance. memory: one process only. */
  readonly nonceStore: "postgres" | "memory";
  /** Set when nonceStore is postgres. */
  readonly databaseUrl?: string | undefined;
  /** The endpoint URL registered in parmana-core, for signed releases. Unset, those are refused. */
  readonly releaseAudience?: string | undefined;
}

export interface ConfigReaders {
  readonly readFile: (path: string) => string;
}

const MIN_TOKEN_LENGTH = 32;

export function loadServiceConfig(
  env: Readonly<Record<string, string | undefined>>,
  readers: ConfigReaders,
): ServiceConfig {
  const bearerToken = required(env, "PARMANA_SERVICE_BEARER_TOKEN");
  if (bearerToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(`PARMANA_SERVICE_BEARER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }

  required(env, "PARMANA_POLICY_DIR");

  const publicKeyPath = required(env, "PARMANA_PUBLIC_KEY_FILE");
  const publicKey = parsePublicKey(readers.readFile(publicKeyPath), "PARMANA_PUBLIC_KEY_FILE");

  const manifestPath = required(env, "PARMANA_CONNECTOR_MANIFEST");
  const manifestResult = loadManifest(readers.readFile(manifestPath));
  if (!manifestResult.ok) {
    const first = manifestResult.errors[0];
    throw new ConfigError(`PARMANA_CONNECTOR_MANIFEST is invalid at ${first?.path || "/"}: ${first?.message ?? "invalid"}`);
  }
  const manifest = manifestResult.manifest;

  // The upstream secret must be present now, so a missing value fails at startup and not on the first request.
  const credentialVariable = manifest.credential.secretRef;
  required(env, credentialVariable);

  const port = parseInteger(env.PARMANA_SERVICE_PORT ?? "8080", "PARMANA_SERVICE_PORT", 1, 65535);
  const host = env.PARMANA_SERVICE_HOST ?? "127.0.0.1";
  const timeoutMs = parseInteger(env.PARMANA_CONNECTOR_TIMEOUT_MS ?? "10000", "PARMANA_CONNECTOR_TIMEOUT_MS", 100, 120_000);

  const nonceStore = parseNonceStore(env.PARMANA_NONCE_STORE);
  const databaseUrl = nonceStore === "postgres" ? required(env, "PARMANA_DATABASE_URL") : undefined;

  const releaseAudience = optionalHttpsUrl(env, "PARMANA_RELEASE_AUDIENCE");

  return { port, host, bearerToken, publicKey, manifest, credentialVariable, timeoutMs, nonceStore, databaseUrl, releaseAudience };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

function parsePublicKey(pem: string, name: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new ConfigError(`${name} must be an Ed25519 public key`);
    }
    return key;
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError(`${name} is not a valid PEM public key`);
  }
}

/**
 * Defaults to postgres. The memory store must be asked for by name, because it
 * does not share replay protection between instances.
 */
function parseNonceStore(raw: string | undefined): "postgres" | "memory" {
  if (raw === undefined || raw === "postgres") return "postgres";
  if (raw === "memory") return "memory";
  throw new ConfigError("PARMANA_NONCE_STORE must be postgres or memory");
}

function parseInteger(raw: string, name: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/** An optional https URL. Unset or empty returns undefined. Anything else stops startup and names the variable. */
function optionalHttpsUrl(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value === "") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an absolute https URL.`);
  }
  if (url.protocol !== "https:") {
    throw new ConfigError(`${name} must use https://.`);
  }
  return value;
}
