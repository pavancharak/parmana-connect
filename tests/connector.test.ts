import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectorError, createGenericConnector, type CredentialHandle } from "../src/connector.js";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
}

const TOKEN = "pat-test-SECRET-123";
const credential: CredentialHandle = { providerId: "test", credentialId: "HUBSPOT_PRIVATE_APP_TOKEN", value: TOKEN };
const context = { credential, timeoutMs: 2_000 };

let server: Server;
let other: Server;
let baseUrl: string;
let otherUrl: string;
let seen: Seen[] = [];
let otherSeen: Seen[] = [];
let slow = false;

function record(log: Seen[], req: IncomingMessage) {
  log.push({ method: req.method, url: req.url, headers: req.headers });
}

beforeAll(async () => {
  other = createServer((req, res) => {
    record(otherSeen, req);
    res.end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    record(seen, req);
    const url = new URL(req.url ?? "/", "http://x");
    if (slow) return; // never answers; the connector must time out
    if (url.pathname.startsWith("/redirect")) {
      res.writeHead(302, { Location: `${otherUrl}/steal` });
      return res.end();
    }
    if (url.pathname.startsWith("/missing")) {
      res.writeHead(404, { "Content-Type": "application/json" });
      return res.end('{"message":"not found"}');
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  slow = false;
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => other.close(resolve));
});

beforeEach(() => {
  seen = [];
  otherSeen = [];
  slow = false;
});

function manifest(overrides: { credential?: unknown; capabilities?: unknown[] } = {}) {
  return {
    system: "hubspot",
    baseUrl,
    apiVersion: "v3",
    credential: overrides.credential ?? { type: "bearer", secretRef: "HUBSPOT_PRIVATE_APP_TOKEN" },
    capabilities: overrides.capabilities ?? [
      {
        id: "hubspot:deal-fetch",
        method: "GET",
        path: "/crm/v3/objects/deals/{dealId}",
        effect: "read",
        input: {
          dealId: { type: "string", required: true },
          properties: { type: "array" },
        },
      },
    ],
  };
}

async function expectConnectorError(promise: Promise<unknown>, code: string, fragment?: string) {
  const err = await promise.then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as ConnectorError).code).toBe(code);
  if (fragment) expect((err as ConnectorError).message).toContain(fragment);
  // The secret must never appear in an error message.
  expect((err as ConnectorError).message).not.toContain(TOKEN);
  return err as ConnectorError;
}

describe("construction", () => {
  it("refuses an invalid manifest before any network call", () => {
    expect(() => createGenericConnector({ ...manifest(), baseUrl: "http://example.com" })).toThrow(ConnectorError);
    expect(seen).toHaveLength(0);
  });

  it("declares only read capabilities", () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [
          { id: "hubspot:deal-fetch", method: "GET", path: "/deals", effect: "read" },
          { id: "hubspot:deal-update", method: "PATCH", path: "/deals", effect: "write", input: { x: { type: "string" } } },
        ],
      }),
      { allowInsecureBaseUrl: true },
    );
    expect(connector.capabilities).toEqual(["hubspot:deal-fetch"]);
  });
});

describe("execute: success", () => {
  it("sends a GET with the path parameter, query and bearer token, and returns the body", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    const result = await connector.execute(
      { capability: "hubspot:deal-fetch", parameters: { dealId: "123", properties: ["amount"] } },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.metadata.status).toBe(200);
    expect(result.metadata.body).toEqual({
      path: "/crm/v3/objects/deals/123",
      query: { properties: '["amount"]' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("sends a header credential under the declared header name", async () => {
    const connector = createGenericConnector(
      manifest({ credential: { type: "header", headerName: "X-Api-Key", secretRef: "HUBSPOT_PRIVATE_APP_TOKEN" } }),
      { allowInsecureBaseUrl: true },
    );
    await connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, context);
    expect(seen[0]?.headers["x-api-key"]).toBe(TOKEN);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("URL-encodes a path parameter so it cannot change the path", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "a/../b c" } }, context);
    expect(seen[0]?.url).toBe("/crm/v3/objects/deals/a%2F..%2Fb%20c");
  });
});

describe("execute: refused before any network call", () => {
  it("refuses a capability the manifest does not declare", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-delete", parameters: {} }, context),
      "unknown_capability",
      "hubspot:deal-delete",
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a write capability, which this version does not run", async () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [
          { id: "hubspot:deal-update", method: "PATCH", path: "/deals/{dealId}", effect: "write", input: { dealId: { type: "string", required: true } } },
        ],
      }),
      { allowInsecureBaseUrl: true },
    );
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-update", parameters: { dealId: "1" } }, context),
      "unsupported_effect",
      "write capabilities are not supported yet",
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a request missing a required input", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: {} }, context),
      "invalid_input",
      'input "dealId" is required',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an input of the wrong type", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: 42 } }, context),
      "invalid_input",
      'input "dealId" must be string',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an input the manifest does not declare", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1", admin: true } }, context),
      "invalid_input",
      'input "admin" is not declared',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an empty credential, naming the reference and not the value", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    const empty = { ...context, credential: { ...credential, value: "" } };
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, empty),
      "credential_invalid",
      "HUBSPOT_PRIVATE_APP_TOKEN",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("execute: upstream failures", () => {
  it("reports a non-2xx status without echoing the upstream body", async () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [{ id: "hubspot:deal-fetch", method: "GET", path: "/missing/{dealId}", effect: "read", input: { dealId: { type: "string", required: true } } }],
      }),
      { allowInsecureBaseUrl: true },
    );
    const err = await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, context),
      "upstream_error",
      "returned status 404",
    );
    expect(err.message).not.toContain("not found");
  });

  it("refuses to follow a redirect, so the token never reaches another host", async () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [{ id: "hubspot:deal-fetch", method: "GET", path: "/redirect/{dealId}", effect: "read", input: { dealId: { type: "string", required: true } } }],
      }),
      { allowInsecureBaseUrl: true },
    );
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, context),
      "upstream_error",
      "redirects are refused",
    );
    expect(otherSeen).toHaveLength(0);
  });

  it("refuses a response larger than the limit", async () => {
    const big = createGenericConnector(manifest(), { allowInsecureBaseUrl: true, maxResponseBytes: 10 });
    await expectConnectorError(
      big.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, context),
      "upstream_error",
      "response larger than 10 bytes",
    );
  });

  it("times out when the upstream never answers", async () => {
    slow = true;
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, { ...context, timeoutMs: 100 }),
      "timeout",
      "no response within 100 ms",
    );
  });

  it("refuses a connection to a host that is not listening", async () => {
    const closedPort = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const port = (probe.address() as AddressInfo).port;
        probe.close(() => resolve(port));
      });
    });
    const connector = createGenericConnector({ ...manifest(), baseUrl: `http://127.0.0.1:${closedPort}` }, { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "hubspot:deal-fetch", parameters: { dealId: "1" } }, context),
      "upstream_error",
      "request failed",
    );
  });
});
