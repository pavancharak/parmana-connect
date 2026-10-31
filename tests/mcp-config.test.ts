import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/config.js";
import { loadMcpConfig, loadMcpHttpConfig } from "../src/mcp-config.js";

const complete = {
  PARMANA_API_URL: "https://parmana.example",
  PARMANA_API_KEY: "key-value",
  PARMANA_AUTHORITY_ID: "authority-1",
  PARMANA_AUTHORITY_TYPE: "SERVICE",
  PARMANA_PRINCIPAL_ID: "example-agent",
  PARMANA_AUTHORIZATION_ID: "authorization-1",
  PARMANA_AUTHORIZATION_PURPOSE: "Read items",
  PARMANA_CONNECTOR_MANIFEST: "/manifest.json",
};

function refusal(overrides: Record<string, string | undefined>): string {
  try {
    loadMcpConfig({ ...complete, ...overrides });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("loadMcpConfig", () => {
  it("accepts a complete configuration and defaults the source system and submitter", () => {
    const config = loadMcpConfig(complete);

    expect(config.sourceSystem).toBe("parmana-connect");
    expect(config.submittedBy).toBe("example-agent");
  });

  it("refuses a Parmana URL that is not https, because the key would travel in clear text", () => {
    expect(refusal({ PARMANA_API_URL: "http://parmana.example" })).toBe("PARMANA_API_URL must use https://");
  });

  it("refuses an authority type it does not know", () => {
    expect(refusal({ PARMANA_AUTHORITY_TYPE: "ADMIN" })).toBe("PARMANA_AUTHORITY_TYPE must be USER, ROLE, SERVICE or ORGANIZATION");
  });

  it("refuses a missing key and names the variable, never a value", () => {
    expect(refusal({ PARMANA_API_KEY: undefined })).toBe("PARMANA_API_KEY is required");
  });
});

const httpComplete = { ...complete, PARMANA_MCP_BEARER_TOKEN: "b".repeat(40) };

function httpRefusal(overrides: Record<string, string | undefined>): string {
  try {
    loadMcpHttpConfig({ ...httpComplete, ...overrides });
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as Error).message;
  }
  throw new Error("expected the configuration to be refused");
}

describe("loadMcpHttpConfig", () => {
  it("defaults to loopback on port 8081", () => {
    const config = loadMcpHttpConfig(httpComplete);

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8081);
  });

  it("refuses a bearer token shorter than 32 characters, and names the variable only", () => {
    expect(httpRefusal({ PARMANA_MCP_BEARER_TOKEN: "short" })).toBe("PARMANA_MCP_BEARER_TOKEN must be at least 32 characters");
  });

  it("refuses a port outside 1 to 65535", () => {
    expect(httpRefusal({ PARMANA_MCP_PORT: "70000" })).toBe("PARMANA_MCP_PORT must be an integer from 1 to 65535");
    expect(httpRefusal({ PARMANA_MCP_PORT: "eighty" })).toBe("PARMANA_MCP_PORT must be an integer from 1 to 65535");
  });

  it("still applies the stdio checks, such as https for the Parmana URL", () => {
    expect(httpRefusal({ PARMANA_API_URL: "http://parmana.example" })).toBe("PARMANA_API_URL must use https://");
  });
});
