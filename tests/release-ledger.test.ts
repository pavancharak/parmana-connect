import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { CanonicalSerializer } from "@parmana/crypto";

import { createGenericConnector } from "../src/connector.js";
import { createExecutionService } from "../src/execution-service.js";
import type { ExternalRelease, SignedExternalRelease } from "../src/external-release.js";
import {
  CREATE_RELEASE_LEDGER_SQL,
  MemoryReleaseLedger,
  PostgresReleaseLedger,
  RELEASE_LEDGER_TABLE,
} from "../src/release-ledger.js";

process.env.PARMANA_POLICY_DIR ??= mkdtempSync(join(tmpdir(), "parmana-policies-"));

const AUDIENCE = "https://parmana-connect.example.com/execute";
const ACTION = "example:item-fetch";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");

let upstream: Server;
let upstreamCalls: string[] = [];
let service: Server;
let serviceUrl: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    upstreamCalls.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "1" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const connector = createGenericConnector(
    {
      system: "example",
      baseUrl: upstreamUrl,
      apiVersion: "v3",
      credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
      capabilities: [{ id: ACTION, method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
    },
    { allowInsecureBaseUrl: true },
  );
  const handler = createExecutionService({
    bearerToken: "x".repeat(32),
    publicKey,
    connector,
    resolveCredential: () => "secret",
    credentialId: "EXAMPLE_TOKEN",
    releaseAudience: AUDIENCE,
    releaseOnly: true,
    releaseLedger: new MemoryReleaseLedger(),
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

function release(id: string): ExternalRelease {
  return {
    version: 1,
    connectorId: "ext-example:item-fetch",
    audience: AUDIENCE,
    businessTransactionId: id,
    authorizationId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    capability: ACTION,
    target: "items/1",
    parameters: { itemId: "1" },
    policy: { name: "policy-a", version: "1.0.0" },
    approvedBy: [],
    // A 60 s window around now: the endpoint reads the real clock.
    ...releaseWindow(),
  };
}

function signRelease(body: ExternalRelease, key: KeyObject = privateKey): SignedExternalRelease {
  const value = sign(null, Buffer.from(new CanonicalSerializer().serialize(body)), key).toString("base64");
  return { release: body, signature: { algorithm: "ed25519", keyId: "default", value } };
}

async function post(payload: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${serviceUrl}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe("release answers at the endpoint", () => {
  it("a repeat gets the first answer and the connector runs once", async () => {
    const signed = signRelease(release("ledger-repeat-1"));
    const first = await post(signed);
    const second = await post(signed);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(upstreamCalls).toHaveLength(1);
  });

  it("two identical releases sent at once run the connector once", async () => {
    const signed = signRelease(release("ledger-concurrent-1"));
    const [a, b] = await Promise.all([post(signed), post(signed)]);

    expect(upstreamCalls).toHaveLength(1);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1]);
  });

  it("an altered release for an already-answered id gets no stored answer", async () => {
    const id = "ledger-forged-1";
    await post(signRelease(release(id)));

    const forged = signRelease({ ...release(id), parameters: { itemId: "999" } }, otherKey.privateKey);
    const result = await post(forged);

    expect(result.status).toBe(403);
    expect(result.json).not.toHaveProperty("result");
    expect(upstreamCalls).toHaveLength(1);
  });
});

describe("MemoryReleaseLedger", () => {
  it("claims once, and answers later claims with the stored answer", async () => {
    const ledger = new MemoryReleaseLedger();
    expect(await ledger.claim("m-1", "2099-01-01T00:00:00.000Z")).toEqual({ claimed: true });
    expect(await ledger.claim("m-1", "2099-01-01T00:00:00.000Z")).toEqual({ claimed: false });
    await ledger.complete("m-1", { success: true });
    expect(await ledger.claim("m-1", "2099-01-01T00:00:00.000Z")).toEqual({ claimed: false, answer: { success: true } });
  });
});

const databaseUrl = process.env.PARMANA_TEST_DATABASE_URL;

describe.skipIf(databaseUrl === undefined)("PostgresReleaseLedger", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const ledger = new PostgresReleaseLedger(pool);

  beforeAll(async () => {
    await pool.query(CREATE_RELEASE_LEDGER_SQL);
    await pool.query(`DELETE FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id LIKE 'pg-test-%'`);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id LIKE 'pg-test-%'`);
    await pool.end();
  });

  it("claims once across racing callers, and returns the stored answer afterwards", async () => {
    const expires = "2099-01-01T00:00:00.000Z";
    const results = await Promise.all([ledger.claim("pg-test-1", expires), ledger.claim("pg-test-1", expires)]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);

    await ledger.complete("pg-test-1", { success: true, result: { id: "1" } });
    expect(await ledger.claim("pg-test-1", expires)).toEqual({
      claimed: false,
      answer: { success: true, result: { id: "1" } },
    });
  });

  it("reports an unanswered claim as in progress, not as an answer", async () => {
    const expires = "2099-01-01T00:00:00.000Z";
    await ledger.claim("pg-test-2", expires);
    expect(await ledger.claim("pg-test-2", expires)).toEqual({ claimed: false });
  });
});

/** One clock reading, so the window is exactly 60 s and never 60 s plus a millisecond. */
function releaseWindow(): { issuedAt: string; expiresAt: string } {
  const now = Date.now();
  return { issuedAt: new Date(now - 30_000).toISOString(), expiresAt: new Date(now + 30_000).toISOString() };
}
