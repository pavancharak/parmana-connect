import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CanonicalSerializer } from "@parmana/crypto";
import { MemoryNonceStore } from "@parmana/envelope-verifier";

import type { GenericConnector } from "../src/connector.js";
import { createExecutionService } from "../src/execution-service.js";
import {
  verifyExternalRelease,
  type ExternalRelease,
  type SignedExternalRelease,
} from "../src/external-release.js";

// A release is signed the way parmana-core signs one: Ed25519 over the
// canonical serialization of the release object, base64 in signature.value.

const AUDIENCE = "https://parmana-connect.example.com/execute";
const NOW = new Date("2026-10-29T06:00:00.000Z");

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function release(overrides: Partial<ExternalRelease> = {}): ExternalRelease {
  return {
    version: 1,
    connectorId: "ext-httpbin:get",
    audience: AUDIENCE,
    businessTransactionId: "11111111-2222-4333-8444-555555555555",
    authorizationId: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    capability: "httpbin:get",
    target: "httpbin",
    parameters: {},
    policy: { name: "httpbin-read", version: "1.0.0" },
    approvedBy: [],
    issuedAt: "2026-10-29T05:59:30.000Z",
    expiresAt: "2026-10-29T06:00:30.000Z",
    ...overrides,
  };
}

function signed(
  body: ExternalRelease,
  key: KeyObject = privateKey,
  keyId = "default",
): SignedExternalRelease {
  const value = sign(
    null,
    Buffer.from(new CanonicalSerializer().serialize(body)),
    key,
  ).toString("base64");
  return { release: body, signature: { algorithm: "ed25519", keyId, value } };
}

function options(nonceStore = new MemoryNonceStore()) {
  return {
    publicKey,
    audience: AUDIENCE,
    capabilities: ["httpbin:get"],
    now: NOW,
    nonceStore,
  };
}

describe("verifyExternalRelease", () => {
  it("accepts a correctly signed release once, and refuses the same businessTransactionId again", async () => {
    const store = new MemoryNonceStore();
    const body = signed(release());

    const first = await verifyExternalRelease(body, options(store));
    expect(first.valid).toBe(true);

    const second = await verifyExternalRelease(body, options(store));
    expect(second).toEqual({
      valid: false,
      errors: ["this businessTransactionId was already executed"],
    });
  });

  it("refuses a release whose parameters were changed after signing", async () => {
    const body = signed(release());
    const tampered = {
      ...body,
      release: { ...body.release, parameters: { itemId: "999" } },
    };

    const check = await verifyExternalRelease(tampered, options());
    expect(check).toEqual({
      valid: false,
      errors: ["the signature does not verify"],
    });
  });

  it("refuses a signature from another key", async () => {
    const other = generateKeyPairSync("ed25519").privateKey;

    const check = await verifyExternalRelease(
      signed(release(), other),
      options(),
    );
    expect(check).toEqual({
      valid: false,
      errors: ["the signature does not verify"],
    });
  });

  it("refuses a signature that does not name the default key", async () => {
    const check = await verifyExternalRelease(
      signed(release(), privateKey, "other-key"),
      options(),
    );
    expect(check).toEqual({
      valid: false,
      errors: ["signature.keyId must be default"],
    });
  });

  it("refuses a release addressed to a different endpoint", async () => {
    const body = signed(
      release({ audience: "https://elsewhere.example.com/execute" }),
    );

    const check = await verifyExternalRelease(body, options());
    expect(check.valid).toBe(false);
    expect(check.valid === false && check.errors[0]).toContain(
      "is not this endpoint",
    );
  });

  it("refuses an expired release, and allows the 30 second clock skew", async () => {
    const expired = signed(
      release({
        issuedAt: "2026-10-29T05:58:00.000Z",
        expiresAt: "2026-10-29T05:59:00.000Z",
      }),
    );
    const check = await verifyExternalRelease(expired, options());
    expect(check.valid === false && check.errors[0]).toContain(
      "the release expired at",
    );

    const inSkew = signed(
      release({
        issuedAt: "2026-10-29T05:58:45.000Z",
        expiresAt: "2026-10-29T05:59:45.000Z",
      }),
    );
    expect((await verifyExternalRelease(inSkew, options())).valid).toBe(true);
  });

  it("refuses a release issued in the future beyond the 30 second clock skew", async () => {
    const future = signed(
      release({
        businessTransactionId: "22222222-3333-4444-8555-666666666666",
        issuedAt: "2026-10-29T06:02:00.000Z",
        expiresAt: "2026-10-29T06:03:00.000Z",
      }),
    );
    const check = await verifyExternalRelease(future, options());
    expect(check.valid === false && check.errors[0]).toContain(
      "issued in the future",
    );

    const slightlyAhead = signed(
      release({
        businessTransactionId: "33333333-4444-4555-8666-777777777777",
        issuedAt: "2026-10-29T06:00:20.000Z",
        expiresAt: "2026-10-29T06:01:20.000Z",
      }),
    );
    expect((await verifyExternalRelease(slightlyAhead, options())).valid).toBe(true);
  });

  it("refuses a release whose lifetime is longer than 60 seconds", async () => {
    const long = signed(
      release({
        businessTransactionId: "44444444-5555-4666-8777-888888888888",
        issuedAt: "2026-10-29T05:59:30.000Z",
        expiresAt: "2026-10-29T06:00:31.000Z",
      }),
    );
    const check = await verifyExternalRelease(long, options());
    expect(check.valid === false && check.errors[0]).toContain(
      "the release lifetime is 61 s; the limit is 60 s",
    );
  });

  it("refuses a release whose expiresAt is not after issuedAt", async () => {
    const inverted = signed(
      release({
        businessTransactionId: "55555555-6666-4777-8888-999999999999",
        issuedAt: "2026-10-29T05:59:40.000Z",
        expiresAt: "2026-10-29T05:59:30.000Z",
      }),
    );
    const check = await verifyExternalRelease(inverted, options());
    expect(check.valid === false && check.errors).toContain(
      "release.expiresAt must be after release.issuedAt",
    );
  });

  it("refuses a capability this endpoint does not serve, and leaves its replay record unused", async () => {
    const store = new MemoryNonceStore();
    const unserved = signed(
      release({
        capability: "httpbin:delete",
        businessTransactionId: "99999999-8888-4777-8666-555555555555",
      }),
    );

    const check = await verifyExternalRelease(unserved, options(store));
    expect(check).toEqual({
      valid: false,
      errors: [
        'release.capability "httpbin:delete" is not served by this endpoint',
      ],
    });

    // The refusal happened before the replay write, so the same id is still fresh.
    expect(
      await store.checkAndRecord(
        "release:99999999-8888-4777-8666-555555555555",
        "2099-01-01T00:00:00.000Z",
      ),
    ).toBe(true);
  });

  it("refuses a release that is not a release", async () => {
    const check = await verifyExternalRelease(
      {
        release: release({ capability: "" }),
        signature: { algorithm: "ed25519", keyId: "default", value: "" },
      },
      options(),
    );
    expect(check.valid).toBe(false);
    expect(check.valid === false && check.errors).toContain(
      "release.capability must be a non-empty string",
    );
  });
});

describe("POST /execute with a signed release", () => {
  let server: Server;
  let url: string;
  const calls: unknown[] = [];

  beforeAll(async () => {
    process.env.PARMANA_POLICY_DIR ??= mkdtempSync(
      join(tmpdir(), "release-policies-"),
    );
    const connector = {
      system: "httpbin",
      capabilities: ["httpbin:get"],
      async execute(request: unknown) {
        calls.push(request);
        return { success: true, metadata: { status: 200, body: { args: {} } } };
      },
    } as unknown as GenericConnector;

    const handler = createExecutionService({
      bearerToken: "service-bearer-for-release-tests-0000",
      publicKey,
      connector,
      resolveCredential: () => "upstream-value",
      credentialId: "HTTPBIN_TOKEN",
      releaseAudience: AUDIENCE,
    });
    server = await handler.listen(0);
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/execute`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  async function post(
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json()) as Record<string, unknown>,
    };
  }

  it("runs the connector and answers in parmana-core's result shape, without a bearer token", async () => {
    const body = signed(
      release({
        businessTransactionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        issuedAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );

    const { status, json } = await post(body);

    expect(status).toBe(200);
    expect(json).toMatchObject({
      businessTransactionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      capability: "httpbin:get",
      success: true,
      result: { status: 200, body: { args: {} } },
    });
    expect(calls).toHaveLength(1);
  });

  it("answers a second run of the same release with the first answer, and does not call the connector again", async () => {
    const body = signed(
      release({
        businessTransactionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        issuedAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    );
    const first = await post(body);
    const before = calls.length;

    const second = await post(body);

    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
    expect(calls.length).toBe(before);
  });
});
