import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ConfigError, loadServiceConfig } from "../src/config.js";
import { fingerprintOf } from "../src/fingerprint.js";

const { publicKey: ed25519Public } = generateKeyPairSync("ed25519");
const ed25519Pem = ed25519Public.export({ type: "spki", format: "pem" }).toString();
const PINNED = fingerprintOf(ed25519Public);

const MANIFEST = JSON.stringify({
  system: "example",
  baseUrl: "https://api.example.com",
  apiVersion: "v1",
  credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
  capabilities: [{ id: "example:item-fetch", method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
});

const AUDIENCE = "https://service.example.com/execute";
const readers = {
  readFile: (path: string) => {
    if (path === "/keys/parmana.pem") return ed25519Pem;
    if (path === "/manifest.json") return MANIFEST;
    throw new Error(`no such file: ${path}`);
  },
};

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_SERVICE_BEARER_TOKEN: "a".repeat(32),
    PARMANA_POLICY_DIR: "/policies",
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_CONNECTOR_MANIFEST: "/manifest.json",
    EXAMPLE_TOKEN: "upstream-value",
    PARMANA_NONCE_STORE: "memory",
    PARMANA_RELEASE_AUDIENCE: AUDIENCE,
    ...overrides,
  };
}

describe("startup pins", () => {
  it("starts when no pins are set, as before", () => {
    expect(() => loadServiceConfig(env(), readers)).not.toThrow();
  });

  it("starts when the key matches the pinned fingerprint", () => {
    expect(() => loadServiceConfig(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: PINNED }), readers)).not.toThrow();
  });

  it("refuses to start when the key does not match the pinned fingerprint", () => {
    const wrong = "sha256:" + "0".repeat(64);
    expect(() => loadServiceConfig(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: wrong }), readers)).toThrow(ConfigError);
    expect(() => loadServiceConfig(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: wrong }), readers)).toThrow(/PARMANA_EXPECTED_KEY_FINGERPRINT/);
  });

  it("starts when the audience equals the pinned audience", () => {
    expect(() => loadServiceConfig(env({ PARMANA_EXPECTED_AUDIENCE: AUDIENCE }), readers)).not.toThrow();
  });

  it("refuses to start when the audience differs from the pinned audience by one character", () => {
    expect(() => loadServiceConfig(env({ PARMANA_EXPECTED_AUDIENCE: AUDIENCE + "/" }), readers)).toThrow(/PARMANA_RELEASE_AUDIENCE does not match/);
  });

  it("refuses to start when an audience is pinned but none is set", () => {
    expect(() => loadServiceConfig(env({ PARMANA_RELEASE_AUDIENCE: undefined, PARMANA_EXPECTED_AUDIENCE: AUDIENCE }), readers)).toThrow(/PARMANA_RELEASE_AUDIENCE is not/);
  });

  it("does not print the secret or the bearer token in a pin error", () => {
    try {
      loadServiceConfig(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: "sha256:" + "1".repeat(64) }), readers);
      throw new Error("expected a refusal");
    } catch (err) {
      expect(String(err)).not.toContain("a".repeat(32));
      expect(String(err)).not.toContain("upstream-value");
    }
  });
});
