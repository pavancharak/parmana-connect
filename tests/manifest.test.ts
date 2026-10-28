import { describe, expect, it } from "vitest";
import { loadManifest, validateManifest, type ManifestError } from "../src/index.js";

const validYaml = `
system: hubspot
baseUrl: https://api.hubapi.com
apiVersion: v3
credential:
  type: bearer
  secretRef: HUBSPOT_PRIVATE_APP_TOKEN
capabilities:
  - id: hubspot:deal-fetch
    method: GET
    path: /crm/v3/objects/deals/{dealId}
    effect: read
    input:
      dealId: { type: string, required: true }
  - id: hubspot:deal-update
    method: PATCH
    path: /crm/v3/objects/deals/{dealId}
    effect: write
    input:
      dealId: { type: string, required: true }
      properties: { type: object, required: true }
`;

function expectErrors(result: ReturnType<typeof loadManifest>): ManifestError[] {
  if (result.ok) throw new Error("expected the manifest to be rejected");
  return result.errors;
}

function withCapability(overrides: Record<string, unknown>) {
  return {
    system: "hubspot",
    baseUrl: "https://api.hubapi.com",
    apiVersion: "v3",
    credential: { type: "bearer", secretRef: "HUBSPOT_PRIVATE_APP_TOKEN" },
    capabilities: [
      { id: "hubspot:deal-fetch", method: "GET", path: "/deals/{dealId}", effect: "read", input: { dealId: { type: "string", required: true } }, ...overrides },
    ],
  };
}

describe("loadManifest", () => {
  it("accepts a valid read and write manifest", () => {
    const result = loadManifest(validYaml);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.system).toBe("hubspot");
      expect(result.manifest.capabilities.map((c) => c.id)).toEqual(["hubspot:deal-fetch", "hubspot:deal-update"]);
    }
  });

  it("accepts the same manifest written as JSON", () => {
    const json = JSON.stringify({
      system: "hubspot",
      baseUrl: "https://api.hubapi.com",
      apiVersion: "v3",
      credential: { type: "bearer", secretRef: "HUBSPOT_PRIVATE_APP_TOKEN" },
      capabilities: [{ id: "hubspot:deal-fetch", method: "GET", path: "/deals", effect: "read" }],
    });
    expect(loadManifest(json).ok).toBe(true);
  });

  it("refuses YAML that cannot be parsed", () => {
    const errors = expectErrors(loadManifest("system: [unclosed"));
    expect(errors[0]?.path).toBe("");
    expect(errors[0]?.message).toMatch(/^cannot parse:/);
  });

  it("refuses duplicate keys", () => {
    const errors = expectErrors(loadManifest("system: hubspot\nsystem: github\n"));
    expect(errors[0]?.message).toMatch(/^cannot parse:/);
  });

  it("refuses YAML aliases", () => {
    const text = validYaml.replace("apiVersion: v3", "apiVersion: &v v3\nlabel: *v");
    const errors = expectErrors(loadManifest(text));
    expect(errors[0]?.message).toMatch(/^cannot parse:.*alias/i);
  });
});

describe("schema rules", () => {
  it("refuses an unknown top-level field, so a typo cannot drop a restriction", () => {
    const errors = expectErrors(loadManifest(validYaml + "basUrl: https://example.com\n"));
    expect(errors).toContainEqual({ path: "", message: "must NOT have additional properties" });
  });

  it("refuses a literal credential value instead of a secret reference", () => {
    const text = validYaml.replace("secretRef: HUBSPOT_PRIVATE_APP_TOKEN", "secretRef: HUBSPOT_PRIVATE_APP_TOKEN\n  value: pat-123");
    const errors = expectErrors(loadManifest(text));
    expect(errors).toContainEqual({ path: "/credential", message: "must NOT have additional properties" });
  });

  it("refuses a secret reference that is not an upper-case name", () => {
    const text = validYaml.replace("HUBSPOT_PRIVATE_APP_TOKEN", "hubspot-token");
    const errors = expectErrors(loadManifest(text));
    expect(errors).toContainEqual({ path: "/credential/secretRef", message: 'must match pattern "^[A-Z][A-Z0-9_]{2,127}$"' });
  });

  it("refuses a capability id without the system prefix pattern", () => {
    const errors = expectErrors(validateManifest(withCapability({ id: "Deal Fetch" })));
    expect(errors).toContainEqual({ path: "/capabilities/0/id", message: 'must match pattern "^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$"' });
  });

  it("refuses a path that carries a query string", () => {
    const errors = expectErrors(validateManifest(withCapability({ path: "/deals?limit=5" })));
    expect(errors[0]?.path).toBe("/capabilities/0/path");
  });

  it("refuses a header credential with no headerName", () => {
    const manifest = withCapability({});
    manifest.credential = { type: "header", secretRef: "GITHUB_TOKEN" } as typeof manifest.credential;
    const errors = expectErrors(validateManifest(manifest));
    expect(errors).toContainEqual({ path: "/credential", message: "must have required property 'headerName'" });
  });
});

describe("semantic rules", () => {
  it("refuses a capability whose id does not start with the system name", () => {
    const text = validYaml.replace("id: hubspot:deal-fetch", "id: github:deal-fetch");
    const errors = expectErrors(loadManifest(text));
    expect(errors).toContainEqual({ path: "/capabilities/0/id", message: 'must start with "hubspot:"' });
  });

  it("refuses two capabilities with the same id", () => {
    const text = validYaml.replace("id: hubspot:deal-update", "id: hubspot:deal-fetch");
    const errors = expectErrors(loadManifest(text));
    expect(errors).toContainEqual({ path: "/capabilities/1/id", message: 'duplicate capability id "hubspot:deal-fetch"' });
  });

  it("refuses a GET capability marked as a write", () => {
    const errors = expectErrors(validateManifest(withCapability({ effect: "write" })));
    expect(errors).toContainEqual({ path: "/capabilities/0/effect", message: "a GET capability cannot be a write" });
  });

  it("refuses a write capability with no declared input", () => {
    const errors = expectErrors(validateManifest(withCapability({ method: "PATCH", effect: "write", input: undefined })));
    expect(errors).toContainEqual({ path: "/capabilities/0/input", message: "a write capability must declare its input" });
  });

  it("refuses a path parameter with no input declared", () => {
    const errors = expectErrors(validateManifest(withCapability({ input: {} })));
    expect(errors).toContainEqual({ path: "/capabilities/0/path", message: "path parameter {dealId} has no input declared" });
  });

  it("refuses a path parameter that is not marked required", () => {
    const errors = expectErrors(validateManifest(withCapability({ input: { dealId: { type: "string" } } })));
    expect(errors).toContainEqual({ path: "/capabilities/0/input/dealId", message: "path parameter {dealId} must be required" });
  });

  it("refuses an http base URL by default", () => {
    const errors = expectErrors(validateManifest({ ...withCapability({}), baseUrl: "http://api.hubapi.com" }));
    expect(errors).toContainEqual({ path: "/baseUrl", message: "must use https://" });
  });

  it("allows an http base URL only when the test flag is set", () => {
    const manifest = { ...withCapability({}), baseUrl: "http://localhost:8080" };
    expect(validateManifest(manifest, { allowInsecureBaseUrl: true }).ok).toBe(true);
  });

  it("refuses a base URL that carries credentials", () => {
    const errors = expectErrors(validateManifest({ ...withCapability({}), baseUrl: "https://user:pass@api.hubapi.com" }));
    expect(errors).toContainEqual({ path: "/baseUrl", message: "must not contain credentials" });
  });

  it("refuses a base URL with a query string", () => {
    const errors = expectErrors(validateManifest({ ...withCapability({}), baseUrl: "https://api.hubapi.com?key=1" }));
    expect(errors).toContainEqual({ path: "/baseUrl", message: "must not contain a query or fragment" });
  });

  it("refuses a base URL that is not absolute", () => {
    const errors = expectErrors(validateManifest({ ...withCapability({}), baseUrl: "api.hubapi.com" }));
    expect(errors).toContainEqual({ path: "/baseUrl", message: "must be an absolute URL" });
  });
});
