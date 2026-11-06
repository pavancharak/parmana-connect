import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AuthorizationSigner, CanonicalSerializer, CryptoBootstrap, ExecutableContentHasher, TrustRecordHasher } from "@parmana/crypto";
import { MemoryNonceStore } from "@parmana/envelope-verifier";
import { toExecutableContent } from "@parmana/shared";

import { ConfigError, loadServiceConfig } from "../src/config.js";
import { createGenericConnector } from "../src/connector.js";
import { createExecutionService } from "../src/execution-service.js";
import type { ExternalRelease, SignedExternalRelease } from "../src/external-release.js";

process.env.PARMANA_POLICY_DIR ??= mkdtempSync(join(tmpdir(), "parmana-policies-"));

const BEARER = "service-bearer-release-only-test";
const SECRET = "upstream-secret-release-only";
const AUDIENCE = "https://parmana-connect.example.com/execute";
const ACTION = "example:item-fetch";
const TARGET = "items/123";
const PARAMETERS = { itemId: "123" };
const TRANSACTION = "txn-release-only-1";

const crypto = CryptoBootstrap.create();
const contentHasher = new ExecutableContentHasher(crypto);
const trustHasher = new TrustRecordHasher(crypto);
const keys = generateKeyPairSync("ed25519");

// ---- configuration -------------------------------------------------------

const { publicKey: configPublic } = generateKeyPairSync("ed25519");
const configPem = configPublic.export({ type: "spki", format: "pem" }).toString();
const MANIFEST = JSON.stringify({
  system: "example",
  baseUrl: "https://api.example.com",
  apiVersion: "v3",
  credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
  capabilities: [{ id: ACTION, method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
});
const readers = {
  readFile: (path: string) => (path === "/keys/parmana.pem" ? configPem : MANIFEST),
};

function configEnv(extra: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    PARMANA_SERVICE_BEARER_TOKEN: "a".repeat(32),
    PARMANA_POLICY_DIR: process.env.PARMANA_POLICY_DIR,
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_CONNECTOR_MANIFEST: "/manifest.json",
    EXAMPLE_TOKEN: "x",
    PARMANA_NONCE_STORE: "memory",
    ...extra,
  };
}

describe("PARMANA_RELEASE_ONLY configuration", () => {
  it("is off when unset", () => {
    expect(loadServiceConfig(configEnv({}), readers).releaseOnly).toBe(false);
  });

  it("is on when set to true, with an audience", () => {
    const config = loadServiceConfig(configEnv({ PARMANA_RELEASE_ONLY: "true", PARMANA_RELEASE_AUDIENCE: AUDIENCE }), readers);
    expect(config.releaseOnly).toBe(true);
  });

  it("refuses to start when true without an audience, since every request would be refused", () => {
    expect(() => loadServiceConfig(configEnv({ PARMANA_RELEASE_ONLY: "true" }), readers)).toThrow(ConfigError);
    expect(() => loadServiceConfig(configEnv({ PARMANA_RELEASE_ONLY: "true" }), readers)).toThrow(/PARMANA_RELEASE_AUDIENCE/);
  });

  it("refuses any value other than true or false, and names the variable", () => {
    expect(() => loadServiceConfig(configEnv({ PARMANA_RELEASE_ONLY: "yes" }), readers)).toThrow(/PARMANA_RELEASE_ONLY must be true or false/);
    expect(() => loadServiceConfig(configEnv({ PARMANA_RELEASE_ONLY: "TRUE" }), readers)).toThrow(/PARMANA_RELEASE_ONLY/);
  });
});

// ---- behaviour at the endpoint -------------------------------------------

let upstream: Server;
let upstreamCalls: { path: string; auth: string | undefined }[] = [];
let service: Server;
let serviceUrl: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    upstreamCalls.push({ path: req.url ?? "", auth: req.headers.authorization });
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
        { id: ACTION, method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } },
      ],
    },
    { allowInsecureBaseUrl: true },
  );

  const handler = createExecutionService({
    bearerToken: BEARER,
    publicKey: keys.publicKey,
    connector,
    resolveCredential: () => SECRET,
    credentialId: "EXAMPLE_TOKEN",
    nonceStore: new MemoryNonceStore(),
    releaseAudience: AUDIENCE,
    releaseOnly: true,
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

async function signedAuthorization() {
  const content = toExecutableContent({
    businessTransactionId: TRANSACTION,
    action: ACTION,
    target: TARGET,
    parameters: PARAMETERS,
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
      grantedCapability: ACTION,
    },
    keys.privateKey,
    "key-1",
    60,
  );
  return signed;
}

function release(overrides: Partial<ExternalRelease> = {}): ExternalRelease {
  return {
    version: 1,
    connectorId: "ext-example:item-fetch",
    audience: AUDIENCE,
    businessTransactionId: `release-${Math.random()}`,
    authorizationId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    capability: ACTION,
    target: TARGET,
    parameters: PARAMETERS,
    policy: { name: "policy-a", version: "1.0.0" },
    approvedBy: [],
    // A 60 s window around now: the endpoint reads the real clock.
    ...releaseWindow(),
    ...overrides,
  };
}

function signRelease(body: ExternalRelease): SignedExternalRelease {
  const value = sign(null, Buffer.from(new CanonicalSerializer().serialize(body)), keys.privateKey).toString("base64");
  return { release: body, signature: { algorithm: "ed25519", keyId: "default", value } };
}

async function post(payload: unknown, token: string | null = BEARER) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${serviceUrl}/execute`, { method: "POST", headers, body: JSON.stringify(payload) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("release-only endpoint", () => {
  it("refuses a valid bearer token plus a valid signed authorization, and never calls the upstream", async () => {
    const authorization = await signedAuthorization();
    const result = await post({
      businessTransactionId: TRANSACTION,
      action: ACTION,
      target: TARGET,
      parameters: PARAMETERS,
      authorization,
    });

    expect(result.status).toBe(403);
    expect(String(result.json.error)).toMatch(/release-only/);
    expect(upstreamCalls).toEqual([]);
  });

  it("refuses a valid bearer token with no release at all", async () => {
    const result = await post({ businessTransactionId: TRANSACTION, action: ACTION, target: TARGET, parameters: PARAMETERS });
    expect(result.status).toBe(403);
    expect(upstreamCalls).toEqual([]);
  });

  it("still runs a valid signed release, and calls the upstream once", async () => {
    const result = await post(signRelease(release()));

    expect(result.status).toBe(200);
    expect(result.json.success).toBe(true);
    expect(upstreamCalls).toEqual([{ path: "/items/123", auth: `Bearer ${SECRET}` }]);
  });

  it("answers a second run of the same signed release with the first answer, without running it again", async () => {
    const signed = signRelease(release());
    const first = await post(signed);
    const again = await post(signed);

    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(upstreamCalls).toHaveLength(1);
  });
});

/** One clock reading, so the window is exactly 60 s and never 60 s plus a millisecond. */
function releaseWindow(): { issuedAt: string; expiresAt: string } {
  const now = Date.now();
  return { issuedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString() };
}
