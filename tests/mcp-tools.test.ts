import { describe, expect, it } from "vitest";

import { loadManifest } from "../src/manifest.js";
import { ParmanaClient, ParmanaUnavailableError } from "../src/parmana-client.js";
import { callTool, toolsFor, type ToolContext } from "../src/mcp-tools.js";

const KEY = "parmana-key-SECRET-789";
const MANIFEST_TEXT = JSON.stringify({
  system: "hubspot",
  baseUrl: "https://api.hubapi.com",
  apiVersion: "v3",
  credential: { type: "bearer", secretRef: "HUBSPOT_TOKEN" },
  capabilities: [
    {
      id: "hubspot:deal-update",
      method: "PATCH",
      path: "/crm/v3/objects/deals/{dealId}",
      effect: "write",
      input: {
        dealId: { type: "string", required: true },
        properties: { type: "object", required: true },
      },
    },
  ],
});

const manifest = (() => {
  const result = loadManifest(MANIFEST_TEXT);
  if (!result.ok) throw new Error("test manifest is invalid");
  return result.manifest;
})();

const POLICY = { capability: "hubspot:deal-update", policy: { name: "deal-policy", version: "2.0.0", schemaVersion: "1.0.0" }, description: null };

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

function stubParmana(execute: { status: number; body: unknown }, options: { policyStatus?: number } = {}) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = init?.headers as Record<string, string> | undefined;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method: init?.method ?? "GET", url, authorization: headers?.Authorization, body });
    if (url.includes("/policies/in-effect")) {
      return new Response(JSON.stringify(POLICY), { status: options.policyStatus ?? 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(execute.body), { status: execute.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const parmana = new ParmanaClient({ baseUrl: "https://parmana.example", apiKey: KEY, fetch: fetchStub });
  return { calls, parmana };
}

function context(parmana: ParmanaClient): ToolContext {
  const ids = ["btx-1", "corr-1", "intent-1"];
  return {
    parmana,
    authority: { authorityId: "authority-1", authorityType: "SERVICE", principalId: "hubspot-agent" },
    authorizationId: "authorization-1",
    purpose: "Update deal stage",
    sourceSystem: "parmana-connect",
    submittedBy: "hubspot-agent",
    now: () => new Date("2026-10-28T10:00:00.000Z"),
    newId: () => ids.shift() ?? "id-extra",
  };
}

const ARGS = { target: "crm/deals/123", dealId: "123", properties: { dealstage: "won" } };

describe("toolsFor", () => {
  it("creates one tool per capability with the capability's own input schema", () => {
    const [tool] = toolsFor(manifest);

    expect(tool?.name).toBe("hubspot:deal-update");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        target: { type: "string", minLength: 1, description: expect.any(String) },
        dealId: { type: "string" },
        properties: { type: "object" },
      },
      required: ["target", "dealId", "properties"],
      additionalProperties: false,
    });
  });
});

describe("callTool: a successful call", () => {
  it("reads the policy in effect, then sends one transaction built from the configuration", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: { status: "RELEASED" } });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", ARGS);

    expect(result.isError).toBe(false);
    expect(calls.map((c) => c.method + " " + new URL(c.url).pathname)).toEqual(["GET /policies/in-effect", "POST /execute"]);
    const sent = calls[1]?.body as Record<string, any>;
    expect(sent.businessTransactionId).toBe("btx-1");
    expect(sent.policy).toEqual({ name: "deal-policy", version: "2.0.0", schemaVersion: "1.0.0" });
    expect(sent.authority).toEqual({ authorityId: "authority-1", authorityType: "SERVICE", principalId: "hubspot-agent", issuedAt: "2026-10-28T10:00:00.000Z" });
    expect(sent.intent).toEqual({
      intentId: "intent-1",
      authorizationId: "authorization-1",
      action: "hubspot:deal-update",
      target: "crm/deals/123",
      parameters: { dealId: "123", properties: { dealstage: "won" } },
      createdAt: "2026-10-28T10:00:00.000Z",
    });
  });

  it("sends the key as a bearer token and never returns it", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: { status: "RELEASED" } });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", ARGS);

    expect(calls[1]?.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("callTool: refusals before anything is sent", () => {
  it("refuses an unknown tool", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: {} });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-delete", ARGS);

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing target", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: {} });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", { dealId: "1", properties: {} });

    expect(result.content[0]?.text).toContain("target is required");
    expect(calls).toHaveLength(0);
  });

  it("refuses an argument the capability does not declare", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: {} });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", { ...ARGS, owner: "someone" });

    expect(result.content[0]?.text).toContain('"owner" is not an input');
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing required input", async () => {
    const { calls, parmana } = stubParmana({ status: 200, body: {} });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", { target: "crm/deals/1", dealId: "1" });

    expect(result.content[0]?.text).toContain('"properties" is required');
    expect(calls).toHaveLength(0);
  });
});

describe("callTool: outcomes", () => {
  const run = async (status: number, body: unknown) => {
    const { calls, parmana } = stubParmana({ status, body });
    const result = await callTool(manifest, context(parmana), "hubspot:deal-update", ARGS);
    return { result, executes: calls.filter((c) => c.method === "POST").length };
  };

  it("reports a policy refusal and sends nothing again", async () => {
    const { result, executes } = await run(403, { code: "POLICY_DENIED" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Refused by policy. Nothing was released.");
    expect(executes).toBe(1);
  });

  it("tells the agent not to resend when the outcome is unknown", async () => {
    const { result, executes } = await run(502, { code: "EXECUTION_OUTCOME_UNKNOWN" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Do not send this again under a new id");
    expect(result.content[0]?.text).toContain("btx-1");
    expect(executes).toBe(1);
  });

  it("tells the agent it may send a new request when the authorization was no longer valid", async () => {
    const { result } = await run(409, { code: "AUTHORIZATION_NO_LONGER_VALID" });

    expect(result.content[0]?.text).toContain("You may send a new request.");
  });

  it("tells the agent not to resend when the record could not be produced", async () => {
    const { result } = await run(500, { code: "EXECUTION_RECORD_INCOMPLETE" });

    expect(result.content[0]?.text).toContain("Do not resend");
  });

  it("reports anything else as a failure, with the status, and retries nothing", async () => {
    const { result, executes } = await run(500, { code: "SOMETHING_ELSE" });

    expect(result.content[0]?.text).toBe("Parmana returned HTTP 500. Nothing was retried.");
    expect(executes).toBe(1);
  });
});

describe("callTool: Parmana unreachable", () => {
  it("raises rather than guessing an outcome", async () => {
    const failing = (async () => {
      throw new TypeError("network down");
    }) as unknown as typeof fetch;
    const parmana = new ParmanaClient({ baseUrl: "https://parmana.example", apiKey: KEY, fetch: failing });

    await expect(callTool(manifest, context(parmana), "hubspot:deal-update", ARGS)).rejects.toBeInstanceOf(ParmanaUnavailableError);
  });
});
