import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthorizationSigner, CryptoBootstrap, ExecutableContentHasher, TrustRecordHasher } from "@parmana/crypto";
import { MemoryNonceStore } from "@parmana/envelope-verifier";
import { toExecutableContent } from "@parmana/shared";

import { createGenericConnector } from "../src/connector.js";
import { createExecutionService } from "../src/execution-service.js";

// CryptoBootstrap reads PARMANA_POLICY_DIR. It only needs a directory here.
process.env.PARMANA_POLICY_DIR ??= mkdtempSync(join(tmpdir(), "parmana-policies-"));

const BEARER = "service-bearer-test";
const SECRET = "upstream-secret-XYZ";
const ACTION = "hubspot:deal-fetch";
const TARGET = "crm/deals/123";
const PARAMETERS = { dealId: "123" };
const TRANSACTION = "txn-service-1";

const crypto = CryptoBootstrap.create();
const contentHasher = new ExecutableContentHasher(crypto);
const trustHasher = new TrustRecordHasher(crypto);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

let upstream: Server;
let upstreamUrl: string;
let upstreamCalls: { path: string; auth: string | undefined }[] = [];
let service: Server;
let serviceUrl: string;
let serviceCalls = 0;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    upstreamCalls.push({ path: req.url ?? "", auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "123" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const connector = createGenericConnector(
    {
      system: "hubspot",
      baseUrl: upstreamUrl,
      apiVersion: "v3",
      credential: { type: "bearer", secretRef: "HUBSPOT_TOKEN" },
      capabilities: [
        {
          id: ACTION,
          method: "GET",
          path: "/deals/{dealId}",
          effect: "read",
          input: { dealId: { type: "string", required: true } },
        },
      ],
    },
    { allowInsecureBaseUrl: true },
  );

  const handler = createExecutionService({
    bearerToken: BEARER,
    publicKey,
    connector,
    resolveCredential: () => SECRET,
    credentialId: "HUBSPOT_TOKEN",
    nonceStore: new MemoryNonceStore(),
  });
  service = await handler.listen(0);
  serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => service.close(resolve));
  await new Promise((resolve) => upstream.close(resolve));
});

beforeEach(() => {
  upstreamCalls = [];
});

async function authorize(overrides: { parameters?: Record<string, unknown>; grantedCapability?: string } = {}) {
  const content = toExecutableContent({
    businessTransactionId: TRANSACTION,
    action: ACTION,
    target: TARGET,
    parameters: overrides.parameters ?? PARAMETERS,
  });
  const signed = await new AuthorizationSigner(crypto).sign(
    {
      decisionId: `decision-${Math.random()}`,
      decisionOutcome: "APPROVED",
      businessTransactionId: TRANSACTION,
      policyName: "policy-a",
      policyVersion: "1.0.0",
      policyContentHash: await trustHasher.hash({ policy: "policy-a" }),
      signalsHash: await trustHasher.hash({ signals: {} }),
      executableContent: content,
      grantedCapability: overrides.grantedCapability ?? ACTION,
    },
    privateKey,
    "key-1",
    60,
  );
  return { signed, content, parameters: overrides.parameters ?? PARAMETERS };
}

function body(authorization: unknown, parameters: Record<string, unknown> = PARAMETERS) {
  return {
    businessTransactionId: TRANSACTION,
    action: ACTION,
    target: TARGET,
    parameters,
    authorization,
  };
}

async function post(payload: unknown, token: string | null = BEARER) {
  serviceCalls += 1;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${serviceUrl}/execute`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("execution service", () => {
  it("runs the connector for a valid, signed authorization", async () => {
    const { signed } = await authorize();
    const result = await post(body(signed));

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(result.json.businessTransactionId).toBe(TRANSACTION);
    expect(upstreamCalls).toEqual([{ path: "/deals/123", auth: `Bearer ${SECRET}` }]);
  });

  it("refuses a missing bearer token before reading the request", async () => {
    const { signed } = await authorize();
    const result = await post(body(signed), null);

    expect(result.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses a wrong bearer token", async () => {
    const { signed } = await authorize();
    const result = await post(body(signed), "not-the-token");

    expect(result.status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses a request with no authorization", async () => {
    const result = await post({ ...body(undefined) });

    expect(result.status).toBe(401);
    expect(result.json.error).toBe("authorization required");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses a tampered request whose parameters differ from the approved ones", async () => {
    const { signed } = await authorize();
    const result = await post(body(signed, { dealId: "999" }));

    expect(result.status).toBe(403);
    expect(result.json.checks).toEqual({ businessTransactionHashMatches: false });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses a replayed authorization on the second use", async () => {
    const { signed } = await authorize();
    const first = await post(body(signed));
    const second = await post(body(signed));

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("refuses an authorization granted for a different action", async () => {
    const { signed } = await authorize({ grantedCapability: "hubspot:deal-update" });
    const result = await post(body(signed));

    expect(result.status).toBe(403);
    expect(result.json.error).toBe("authorization does not cover this action");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses an authorization whose signature was made with another key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey as KeyObject;
    const content = toExecutableContent({
      businessTransactionId: TRANSACTION,
      action: ACTION,
      target: TARGET,
      parameters: PARAMETERS,
    });
    const forged = await new AuthorizationSigner(crypto).sign(
      {
        decisionId: "forged",
        decisionOutcome: "APPROVED",
        businessTransactionId: TRANSACTION,
        policyName: "policy-a",
        policyVersion: "1.0.0",
        policyContentHash: await trustHasher.hash({ policy: "policy-a" }),
        signalsHash: await trustHasher.hash({ signals: {} }),
        executableContent: content,
        grantedCapability: ACTION,
      },
      other,
      "key-1",
      60,
    );
    const result = await post(body(forged));

    expect(result.status).toBe(403);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("refuses a request whose parameters do not match the connector's input schema", async () => {
    const { signed } = await authorize({ parameters: {} });
    const result = await post(body(signed, {}));

    expect(serviceCalls).toBeGreaterThan(0);
    expect(result.status).toBe(422);
    expect(result.json.error).toBe("connector failed: invalid_input");
    expect(upstreamCalls).toHaveLength(0);
  });

  it("never echoes the credential in a response", async () => {
    const { signed } = await authorize({ parameters: {} });
    const result = await post(body(signed, {}));

    expect(JSON.stringify(result.json)).not.toContain(SECRET);
  });
});
