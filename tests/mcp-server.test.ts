import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createMcpServer } from "../src/mcp-server.js";
import { loadManifest } from "../src/manifest.js";
import { ParmanaClient } from "../src/parmana-client.js";

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

async function connect(executeStatus: number, executeBody: unknown) {
  const fetchStub = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/policies/in-effect")) {
      return new Response(JSON.stringify({ capability: "example:item-fetch", policy: { name: "p", version: "1", schemaVersion: "1" }, description: null }), { status: 200 });
    }
    return new Response(JSON.stringify(executeBody), { status: executeStatus, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;

  const parmana = new ParmanaClient({ baseUrl: "https://parmana.example", apiKey: "k".repeat(20), fetch: fetchStub });
  const server = createMcpServer(manifest, {
    parmana,
    authority: { authorityId: "a1", authorityType: "SERVICE", principalId: "agent" },
    authorizationId: "auth1",
    purpose: "Read items",
    sourceSystem: "parmana-connect",
    submittedBy: "agent",
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

describe("MCP server over the protocol", () => {
  it("lists one tool per capability, with the capability's input schema", async () => {
    const { client } = await connect(200, {});
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["example:item-fetch"]);
    expect(tools[0]?.inputSchema.required).toEqual(["target", "itemId"]);
  });

  it("runs a tool call through Parmana and returns the result as text", async () => {
    const { client } = await connect(200, { status: "RELEASED" });
    const result = await client.callTool({ name: "example:item-fetch", arguments: { target: "items/1", itemId: "1" } });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ status: "RELEASED" }) }]);
  });

  it("returns a refusal as an error result, not a thrown error", async () => {
    const { client } = await connect(403, { code: "POLICY_DENIED" });
    const result = await client.callTool({ name: "example:item-fetch", arguments: { target: "items/1", itemId: "1" } });

    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]?.text).toContain("Refused by policy");
  });
});
