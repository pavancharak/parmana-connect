import { type AddressInfo } from "node:net";
import { type Server as HttpServer } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { createMcpServer } from "../src/mcp-server.js";
import { loadManifest } from "../src/manifest.js";
import { ParmanaClient } from "../src/parmana-client.js";
import { createMcpHttpServer, MCP_PATH } from "../src/mcp-http.js";

const TOKEN = "t".repeat(40);

const manifest = (() => {
  const result = loadManifest(
    JSON.stringify({
      system: "example",
      baseUrl: "https://api.hubapi.com",
      apiVersion: "v3",
      credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
      capabilities: [
        {
          id: "example:item-fetch",
          method: "GET",
          path: "/items/{itemId}",
          effect: "read",
          input: { itemId: { type: "string", required: true } },
        },
      ],
    }),
  );
  if (!result.ok) throw new Error("test manifest is invalid");
  return result.manifest;
})();

let http: HttpServer;
let url: URL;

function start(executeStatus: number, executeBody: unknown): Promise<void> {
  const fetchStub = (async (input: string | URL) => {
    if (String(input).includes("/policies/in-effect")) {
      return new Response(
        JSON.stringify({ capability: "example:item-fetch", policy: { name: "p", version: "1", schemaVersion: "1" }, description: null }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(executeBody), { status: executeStatus, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const ctx = {
    parmana: new ParmanaClient({ baseUrl: "https://parmana.example", apiKey: "k".repeat(20), fetch: fetchStub }),
    authority: { authorityId: "a1", authorityType: "SERVICE" as const, principalId: "agent" },
    authorizationId: "auth1",
    purpose: "Read items",
    sourceSystem: "parmana-connect",
    submittedBy: "agent",
  };

  http = createMcpHttpServer({ bearerToken: TOKEN, createMcpServer: () => createMcpServer(manifest, ctx) });
  return new Promise((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      url = new URL(`http://127.0.0.1:${port}${MCP_PATH}`);
      resolve();
    });
  });
}

async function connectClient(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()));
});

describe("MCP server over HTTP: authentication", () => {
  it("refuses a request without a bearer token", async () => {
    await start(200, {});
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  it("refuses a request with the wrong bearer token", async () => {
    await start(200, {});
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"x".repeat(40)}` },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("refuses a token that only shares a prefix with the right one", async () => {
    await start(200, {});
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}extra` },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });

  it("answers 404 for another path, and 405 for a method other than POST", async () => {
    await start(200, {});
    const other = await fetch(new URL("/elsewhere", url), {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const get = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });

    expect(other.status).toBe(404);
    expect(get.status).toBe(405);
  });
});

describe("MCP server over HTTP: tools", () => {
  it("lists the capabilities as tools for an authorized client", async () => {
    await start(200, {});
    const client = await connectClient(TOKEN);
    const { tools } = await client.listTools();
    await client.close();

    expect(tools.map((t) => t.name)).toEqual(["example:item-fetch"]);
  });

  it("returns a refusal from Parmana as an error result, not a thrown error", async () => {
    await start(403, { code: "POLICY_DENIED" });
    const client = await connectClient(TOKEN);
    const result = await client.callTool({ name: "example:item-fetch", arguments: { target: "items/1", itemId: "1" } });
    await client.close();

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("Refused by policy");
  });

  it("returns the signed record of an approved call as text", async () => {
    await start(200, { status: "RELEASED" });
    const client = await connectClient(TOKEN);
    const result = await client.callTool({ name: "example:item-fetch", arguments: { target: "items/1", itemId: "1" } });
    await client.close();

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "RELEASED" }) }]);
  });
});
