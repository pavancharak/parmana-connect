import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfigError, loadServiceConfig } from "../src/config.js";

const { publicKey: ed25519Public } = generateKeyPairSync("ed25519");
const ed25519Pem = ed25519Public.export({ type: "spki", format: "pem" }).toString();
const { publicKey: rsaPublic } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPem = rsaPublic.export({ type: "spki", format: "pem" }).toString();

const MANIFEST = JSON.stringify({
  system: "example",
  baseUrl: "https://api.hubapi.com",
  apiVersion: "v3",
  credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
  capabilities: [{ id: "example:item-fetch", method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
});

const TOKEN = "a".repeat(32);

const files: Record<string, string> = {
  "/keys/parmana.pem": ed25519Pem,
  "/keys/rsa.pem": rsaPem,
  "/manifest.json": MANIFEST,
  "/bad-manifest.json": "{ not json",
};

const readers = {
  readFile: (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error(`no such file: ${path}`);
    return value;
  },
};

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_SERVICE_BEARER_TOKEN: TOKEN,
    PARMANA_POLICY_DIR: "/policies",
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_CONNECTOR_MANIFEST: "/manifest.json",
    EXAMPLE_TOKEN: "upstream-secret",
    PARMANA_DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/parmana",
    ...overrides,
  };
}

function refusal(overrides: Record<string, string | undefined>): string {
  try {
    loadServiceConfig(env(overrides), readers);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("loadServiceConfig", () => {
  it("accepts a complete configuration and applies the defaults", () => {
    const config = loadServiceConfig(env(), readers);

    expect(config.port).toBe(8080);
    expect(config.timeoutMs).toBe(10_000);
    expect(config.credentialVariable).toBe("EXAMPLE_TOKEN");
    expect(config.manifest.system).toBe("example");
    expect(config.nonceStore).toBe("postgres");
    expect(config.databaseUrl).toBe("postgres://user:pass@127.0.0.1:5432/parmana");
  });

  it("uses the memory store only when it is asked for by name, and then needs no database", () => {
    const config = loadServiceConfig(env({ PARMANA_NONCE_STORE: "memory", PARMANA_DATABASE_URL: undefined }), readers);

    expect(config.nonceStore).toBe("memory");
    expect(config.databaseUrl).toBeUndefined();
  });

  it("refuses the postgres store when no database URL is set", () => {
    expect(refusal({ PARMANA_DATABASE_URL: undefined })).toBe("PARMANA_DATABASE_URL is required");
  });

  it("refuses an unknown nonce store name", () => {
    expect(refusal({ PARMANA_NONCE_STORE: "redis" })).toBe("PARMANA_NONCE_STORE must be postgres or memory");
  });

  it("refuses a missing bearer token and names the variable", () => {
    expect(refusal({ PARMANA_SERVICE_BEARER_TOKEN: undefined })).toBe("PARMANA_SERVICE_BEARER_TOKEN is required");
  });

  it("refuses a short bearer token without echoing it", () => {
    const message = refusal({ PARMANA_SERVICE_BEARER_TOKEN: "short" });
    expect(message).toContain("at least 32 characters");
    expect(message).not.toContain("short");
  });

  it("refuses a missing policy directory", () => {
    expect(refusal({ PARMANA_POLICY_DIR: undefined })).toBe("PARMANA_POLICY_DIR is required");
  });

  it("refuses a public key that is not Ed25519", () => {
    expect(refusal({ PARMANA_PUBLIC_KEY_FILE: "/keys/rsa.pem" })).toBe("PARMANA_PUBLIC_KEY_FILE must be an Ed25519 public key");
  });

  it("refuses a manifest that does not validate, with the path of the problem", () => {
    expect(refusal({ PARMANA_CONNECTOR_MANIFEST: "/bad-manifest.json" })).toContain("PARMANA_CONNECTOR_MANIFEST is invalid");
  });

  it("refuses to start when the upstream secret is not set", () => {
    expect(refusal({ EXAMPLE_TOKEN: undefined })).toBe("EXAMPLE_TOKEN is required");
  });

  it("refuses a port outside the valid range", () => {
    expect(refusal({ PARMANA_SERVICE_PORT: "70000" })).toBe("PARMANA_SERVICE_PORT must be an integer from 1 to 65535");
  });
});
