import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConnectorError, createGenericConnector, type CredentialHandle } from "../src/connector.js";

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

const TOKEN = "pat-test-SECRET-123";
const credential: CredentialHandle = { providerId: "test", credentialId: "EXAMPLE_TOKEN", value: TOKEN };
const context = { credential, timeoutMs: 2_000 };

let server: Server;
let other: Server;
let baseUrl: string;
let otherUrl: string;
let seen: Seen[] = [];
let otherSeen: Seen[] = [];
let slow = false;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

beforeAll(async () => {
  other = createServer(async (req, res) => {
    otherSeen.push({ method: req.method, url: req.url, headers: req.headers, body: await readBody(req) });
    res.end("{}");
  });
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  otherUrl = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
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
    if (url.pathname.startsWith("/fail")) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end('{"message":"internal detail"}');
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
    system: "example",
    baseUrl,
    apiVersion: "v3",
    credential: overrides.credential ?? { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
    capabilities: overrides.capabilities ?? [
      {
        id: "example:item-fetch",
        method: "GET",
        path: "/items/{itemId}",
        effect: "read",
        input: {
          itemId: { type: "string", required: true },
          properties: { type: "array" },
        },
      },
    ],
  };
}

const updateItem = {
  id: "example:item-update",
  method: "PATCH",
  path: "/items/{itemId}",
  effect: "write",
  input: {
    itemId: { type: "string", required: true },
    properties: { type: "object", required: true },
  },
};

function writeManifest(capability: Record<string, unknown>) {
  return manifest({ capabilities: [capability] });
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

  it("declares every capability in the manifest, read and write", () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [
          { id: "example:item-fetch", method: "GET", path: "/items", effect: "read" },
          updateItem,
        ],
      }),
      { allowInsecureBaseUrl: true },
    );
    expect(connector.capabilities).toEqual(["example:item-fetch", "example:item-update"]);
  });
});

describe("execute: reads", () => {
  it("sends a GET with the path parameter, query and bearer token, and returns the body", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    const result = await connector.execute(
      { capability: "example:item-fetch", parameters: { itemId: "123", properties: ["amount"] } },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.metadata.status).toBe(200);
    expect(result.metadata.body).toEqual({
      path: "/items/123",
      query: { properties: '["amount"]' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.body).toBe("");
  });

  it("sends a header credential under the declared header name", async () => {
    const connector = createGenericConnector(
      manifest({ credential: { type: "header", headerName: "X-Api-Key", secretRef: "EXAMPLE_TOKEN" } }),
      { allowInsecureBaseUrl: true },
    );
    await connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, context);
    expect(seen[0]?.headers["x-api-key"]).toBe(TOKEN);
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it("URL-encodes a path parameter so it cannot change the path", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await connector.execute({ capability: "example:item-fetch", parameters: { itemId: "a/../b c" } }, context);
    expect(seen[0]?.url).toBe("/items/a%2F..%2Fb%20c");
  });
});

describe("execute: writes", () => {
  it("sends a PATCH with the path parameter in the URL and the other inputs as a JSON body", async () => {
    const connector = createGenericConnector(writeManifest(updateItem), { allowInsecureBaseUrl: true });
    const result = await connector.execute(
      { capability: "example:item-update", parameters: { itemId: "123", properties: { amount: "5000" } } },
      context,
    );

    expect(result.metadata.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PATCH");
    expect(seen[0]?.url).toBe("/items/123");
    expect(seen[0]?.headers["content-type"]).toBe("application/json");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // The path parameter stays in the URL and is not repeated in the body.
    expect(JSON.parse(seen[0]?.body ?? "")).toEqual({ properties: { amount: "5000" } });
  });

  it("sends a DELETE's inputs in the query string, with no body", async () => {
    const connector = createGenericConnector(
      writeManifest({
        id: "example:item-delete",
        method: "DELETE",
        path: "/items/{itemId}",
        effect: "write",
        input: { itemId: { type: "string", required: true }, archived: { type: "boolean" } },
      }),
      { allowInsecureBaseUrl: true },
    );
    await connector.execute({ capability: "example:item-delete", parameters: { itemId: "9", archived: true } }, context);
    expect(seen[0]?.method).toBe("DELETE");
    expect(seen[0]?.url).toBe("/items/9?archived=true");
    expect(seen[0]?.body).toBe("");
    expect(seen[0]?.headers["content-type"]).toBeUndefined();
  });

  it("sends an empty JSON object when a write has only path inputs", async () => {
    const connector = createGenericConnector(
      writeManifest({
        id: "example:item-archive",
        method: "POST",
        path: "/items/{itemId}/archive",
        effect: "write",
        input: { itemId: { type: "string", required: true } },
      }),
      { allowInsecureBaseUrl: true },
    );
    await connector.execute({ capability: "example:item-archive", parameters: { itemId: "9" } }, context);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/items/9/archive");
    expect(seen[0]?.body).toBe("{}");
  });

  it("refuses a write with a missing required input before any network call", async () => {
    const connector = createGenericConnector(writeManifest(updateItem), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-update", parameters: { itemId: "123" } }, context),
      "invalid_input",
      'input "properties" is required',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a write whose body input has the wrong type, before any network call", async () => {
    const connector = createGenericConnector(writeManifest(updateItem), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-update", parameters: { itemId: "123", properties: "amount=5000" } }, context),
      "invalid_input",
      'input "properties" must be object',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a write with an undeclared field, so it cannot smuggle extra data into the body", async () => {
    const connector = createGenericConnector(writeManifest(updateItem), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute(
        { capability: "example:item-update", parameters: { itemId: "123", properties: {}, owner: "someone-else" } },
        context,
      ),
      "invalid_input",
      'input "owner" is not declared',
    );
    expect(seen).toHaveLength(0);
  });

  it("reports a write the upstream rejects, without echoing its body", async () => {
    const connector = createGenericConnector(
      writeManifest({ ...updateItem, path: "/fail/{itemId}" }),
      { allowInsecureBaseUrl: true },
    );
    const err = await expectConnectorError(
      connector.execute({ capability: "example:item-update", parameters: { itemId: "1", properties: {} } }, context),
      "upstream_error",
      "returned status 500",
    );
    expect(err.message).not.toContain("internal detail");
    expect(seen).toHaveLength(1);
  });

  it("refuses to follow a redirect on a write, so the token and the body never reach another host", async () => {
    const connector = createGenericConnector(
      writeManifest({ ...updateItem, path: "/redirect/{itemId}" }),
      { allowInsecureBaseUrl: true },
    );
    await expectConnectorError(
      connector.execute({ capability: "example:item-update", parameters: { itemId: "1", properties: { stage: "won" } } }, context),
      "upstream_error",
      "redirects are refused",
    );
    expect(otherSeen).toHaveLength(0);
  });
});

describe("execute: refused before any network call", () => {
  it("refuses a capability the manifest does not declare", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-delete", parameters: {} }, context),
      "unknown_capability",
      "example:item-delete",
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a request missing a required input", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: {} }, context),
      "invalid_input",
      'input "itemId" is required',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an input of the wrong type", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: 42 } }, context),
      "invalid_input",
      'input "itemId" must be string',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an input the manifest does not declare", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1", admin: true } }, context),
      "invalid_input",
      'input "admin" is not declared',
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses an empty credential, naming the reference and not the value", async () => {
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    const empty = { ...context, credential: { ...credential, value: "" } };
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, empty),
      "credential_invalid",
      "EXAMPLE_TOKEN",
    );
    expect(seen).toHaveLength(0);
  });
});

describe("execute: upstream failures", () => {
  it("reports a non-2xx status without echoing the upstream body", async () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [{ id: "example:item-fetch", method: "GET", path: "/missing/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
      }),
      { allowInsecureBaseUrl: true },
    );
    const err = await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, context),
      "upstream_error",
      "returned status 404",
    );
    expect(err.message).not.toContain("not found");
  });

  it("refuses to follow a redirect, so the token never reaches another host", async () => {
    const connector = createGenericConnector(
      manifest({
        capabilities: [{ id: "example:item-fetch", method: "GET", path: "/redirect/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
      }),
      { allowInsecureBaseUrl: true },
    );
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, context),
      "upstream_error",
      "redirects are refused",
    );
    expect(otherSeen).toHaveLength(0);
  });

  it("refuses a response larger than the limit", async () => {
    const big = createGenericConnector(manifest(), { allowInsecureBaseUrl: true, maxResponseBytes: 10 });
    await expectConnectorError(
      big.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, context),
      "upstream_error",
      "response larger than 10 bytes",
    );
  });

  it("times out when the upstream never answers", async () => {
    slow = true;
    const connector = createGenericConnector(manifest(), { allowInsecureBaseUrl: true });
    await expectConnectorError(
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, { ...context, timeoutMs: 100 }),
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
      connector.execute({ capability: "example:item-fetch", parameters: { itemId: "1" } }, context),
      "upstream_error",
      "request failed",
    );
  });
});
