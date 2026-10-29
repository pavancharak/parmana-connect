import { describe, expect, it } from "vitest";

import { ConfigError } from "../src/config.js";
import { loadMcpConfig } from "../src/mcp-config.js";

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
