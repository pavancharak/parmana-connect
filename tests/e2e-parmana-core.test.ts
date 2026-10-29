import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthorizationSigner, CryptoBootstrap, TrustRecordHasher } from "@parmana/crypto";
import { MemoryNonceStore } from "@parmana/envelope-verifier";
import { HttpExecutionSystem, type ExecutionRequest } from "@parmana/execution-system";
import { toExecutableContent } from "@parmana/shared";

import { createGenericConnector } from "../src/connector.js";
import { createExecutionService } from "../src/execution-service.js";

// End to end: the request is built and sent by parmana-core's own
// HttpExecutionSystem, and the authorization is signed by parmana-core's
// AuthorizationSigner. Only the receiving side is this repository's code.

process.env.PARMANA_POLICY_DIR ??= mkdtempSync(join(tmpdir(), "parmana-policies-"));

const BEARER = "service-bearer-e2e";
const SECRET = "upstream-secret-E2E";
const ACTION = "example:item-fetch";
const TARGET = "items/123";
const TRANSACTION = "txn-e2e-1";

const crypto = CryptoBootstrap.create();
const trustHasher = new TrustRecordHasher(crypto);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

let upstream: Server;
let upstreamCalls = 0;
let service: Server;
let serviceUrl: string;

beforeAll(async () => {
  upstream = createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "123" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const connector = createGenericConnector(
    {
      system: "example",
      baseUrl: upstreamUrl,
      apiVersion: "v3",
      credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
      capabilities: [
        {
          id: ACTION,
          method: "GET",
          path: "/items/{itemId}",
          effect: "read",
          input: { itemId: { type: "string", required: true } },
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
    credentialId: "EXAMPLE_TOKEN",
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
  upstreamCalls = 0;
});

/** Signs an approval the way parmana-core does, then builds the request it would send. */
async function approvedRequest(parameters: Record<string, unknown>): Promise<ExecutionRequest> {
  const content = toExecutableContent({
    businessTransactionId: TRANSACTION,
    action: ACTION,
    target: TARGET,
    parameters,
  });
  const authorization = await new AuthorizationSigner(crypto).sign(
    {
      decisionId: `decision-${TRANSACTION}-${Math.random()}`,
      decisionOutcome: "APPROVED",
      businessTransactionId: TRANSACTION,
      policyName: "policy-a",
      policyVersion: "1.0.0",
      policyContentHash: await trustHasher.hash({ policy: "policy-a" }),
      signalsHash: await trustHasher.hash({ signals: {} }),
      executableContent: content,
      grantedCapability: ACTION,
    },
    privateKey,
    "key-1",
    60,
  );
  return {
    businessTransactionId: TRANSACTION,
    action: ACTION,
    target: TARGET,
    parameters,
    authorization,
  };
}

const executionSystem = () =>
  new HttpExecutionSystem({
    baseUrl: serviceUrl,
    headers: { Authorization: `Bearer ${BEARER}` },
    timeout: 5_000,
  });

describe("parmana-core HttpExecutionSystem -> execution service", () => {
  it("runs an approved action and returns parmana-core's expected result", async () => {
    const request = await approvedRequest({ itemId: "123" });
    const result = await executionSystem().execute(request);

    expect(result.success).toBe(true);
    expect(result.businessTransactionId).toBe(TRANSACTION);
    expect(upstreamCalls).toBe(1);
  });

  it("refuses an action whose parameters were changed after approval", async () => {
    const request = await approvedRequest({ itemId: "123" });
    const tampered = { ...request, parameters: { itemId: "999" } };

    await expect(executionSystem().execute(tampered)).rejects.toThrow("Execution System returned HTTP 403.");
    expect(upstreamCalls).toBe(0);
  });

  it("refuses the same approved action a second time", async () => {
    const request = await approvedRequest({ itemId: "123" });

    await executionSystem().execute(request);
    await expect(executionSystem().execute(request)).rejects.toThrow("Execution System returned HTTP 403.");
    expect(upstreamCalls).toBe(1);
  });

  it("refuses a request with the wrong bearer token", async () => {
    const request = await approvedRequest({ itemId: "123" });
    const wrong = new HttpExecutionSystem({
      baseUrl: serviceUrl,
      headers: { Authorization: "Bearer not-the-token" },
      timeout: 5_000,
    });

    await expect(wrong.execute(request)).rejects.toThrow("Execution System returned HTTP 401.");
    expect(upstreamCalls).toBe(0);
  });
});
