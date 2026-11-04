import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { fingerprintOf, runDoctor, type Check } from "../src/doctor.js";

const { publicKey: ed25519Public } = generateKeyPairSync("ed25519");
const ed25519Pem = ed25519Public.export({ type: "spki", format: "pem" }).toString();
const { publicKey: rsaPublic } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPem = rsaPublic.export({ type: "spki", format: "pem" }).toString();
const PINNED = fingerprintOf(ed25519Public);

const MANIFEST = JSON.stringify({
  system: "example",
  baseUrl: "https://api.example.com",
  apiVersion: "v1",
  credential: { type: "bearer", secretRef: "EXAMPLE_TOKEN" },
  capabilities: [{ id: "example:item-fetch", method: "GET", path: "/items/{itemId}", effect: "read", input: { itemId: { type: "string", required: true } } }],
});

const TOKEN = "a".repeat(32);
const SECRET_VALUE = "upstream-secret-value-do-not-print";

const files: Record<string, string> = {
  "/keys/parmana.pem": ed25519Pem,
  "/keys/rsa.pem": rsaPem,
  "/manifest.json": MANIFEST,
  "/bad-manifest.json": "{ not json",
};

const readers = {
  readFile: (path: string) => {
    const value = files[path];
    if (value === undefined) throw new Error(`no such file: ${path}`);
    return value;
  },
  directoryExists: (path: string) => path === "/policies",
};

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_SERVICE_BEARER_TOKEN: TOKEN,
    PARMANA_POLICY_DIR: "/policies",
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_CONNECTOR_MANIFEST: "/manifest.json",
    EXAMPLE_TOKEN: SECRET_VALUE,
    PARMANA_RELEASE_AUDIENCE: "https://service.example.com/execute",
    PARMANA_EXPECTED_AUDIENCE: "https://service.example.com/execute",
    PARMANA_EXPECTED_KEY_FINGERPRINT: PINNED,
    PARMANA_NONCE_STORE: "memory",
    ...overrides,
  };
}

function check(checks: Check[], name: string): Check {
  const found = checks.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe("doctor", () => {
  it("passes every check for a complete, correct environment", () => {
    const checks = runDoctor(env(), readers);
    expect(checks.filter((item) => item.level === "fail")).toEqual([]);
    expect(check(checks, "PARMANA_PUBLIC_KEY_FILE").level).toBe("pass");
    expect(check(checks, "PARMANA_RELEASE_AUDIENCE").level).toBe("pass");
  });

  it("reports every failure at once instead of stopping at the first", () => {
    const checks = runDoctor(env({ PARMANA_SERVICE_BEARER_TOKEN: undefined, PARMANA_RELEASE_AUDIENCE: undefined }), readers);
    expect(check(checks, "PARMANA_SERVICE_BEARER_TOKEN").level).toBe("fail");
    expect(check(checks, "PARMANA_RELEASE_AUDIENCE").level).toBe("fail");
  });

  it("gives a fix with every failure", () => {
    const checks = runDoctor(env({ PARMANA_SERVICE_BEARER_TOKEN: "short" }), readers);
    for (const item of checks.filter((entry) => entry.level === "fail")) {
      expect(item.fix, item.name).toBeTruthy();
    }
  });

  it("fails a short bearer token and names only the setting", () => {
    const result = check(runDoctor(env({ PARMANA_SERVICE_BEARER_TOKEN: "short" }), readers), "PARMANA_SERVICE_BEARER_TOKEN");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("below the minimum");
  });

  it("fails a policy folder that does not exist", () => {
    expect(check(runDoctor(env({ PARMANA_POLICY_DIR: "/missing" }), readers), "PARMANA_POLICY_DIR").level).toBe("fail");
  });

  it("fails a public key that is not Ed25519", () => {
    const result = check(runDoctor(env({ PARMANA_PUBLIC_KEY_FILE: "/keys/rsa.pem" }), readers), "PARMANA_PUBLIC_KEY_FILE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("not an Ed25519 key");
  });

  it("fails a key whose fingerprint differs from the pinned value", () => {
    const other = fingerprintOf(rsaPublic).replace(/^sha256:/, "sha256:0");
    const result = check(runDoctor(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: other }), readers), "PARMANA_PUBLIC_KEY_FILE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("does not match the pinned value");
  });

  it("warns when no fingerprint is pinned, and shows the value to pin", () => {
    const result = check(runDoctor(env({ PARMANA_EXPECTED_KEY_FINGERPRINT: undefined }), readers), "PARMANA_PUBLIC_KEY_FILE");
    expect(result.level).toBe("warn");
    expect(result.message).toContain(PINNED);
  });

  it("fails an invalid manifest and shows where it is wrong", () => {
    const result = check(runDoctor(env({ PARMANA_CONNECTOR_MANIFEST: "/bad-manifest.json" }), readers), "PARMANA_CONNECTOR_MANIFEST");
    expect(result.level).toBe("fail");
  });

  it("fails when the upstream credential is not set, without printing any value", () => {
    const checks = runDoctor(env({ EXAMPLE_TOKEN: undefined }), readers);
    const result = check(checks, "upstream credential");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("EXAMPLE_TOKEN");
  });

  it("fails when the release audience is missing, because every release would be refused", () => {
    const result = check(runDoctor(env({ PARMANA_RELEASE_AUDIENCE: undefined }), readers), "PARMANA_RELEASE_AUDIENCE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("every release is refused");
  });

  it("fails an audience that is not https", () => {
    const result = check(runDoctor(env({ PARMANA_RELEASE_AUDIENCE: "http://service.example.com/execute" }), readers), "PARMANA_RELEASE_AUDIENCE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("does not use https");
  });

  it("fails an audience that differs from the registered URL by one character", () => {
    const result = check(runDoctor(env({ PARMANA_RELEASE_AUDIENCE: "https://service.example.com/execute/" }), readers), "PARMANA_RELEASE_AUDIENCE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("does not match the URL registered");
  });

  it("warns when the registered audience is not given to compare", () => {
    const result = check(runDoctor(env({ PARMANA_EXPECTED_AUDIENCE: undefined }), readers), "PARMANA_RELEASE_AUDIENCE");
    expect(result.level).toBe("warn");
  });

  it("warns on the memory store, because replay protection is not shared", () => {
    expect(check(runDoctor(env({ PARMANA_NONCE_STORE: "memory" }), readers), "PARMANA_NONCE_STORE").level).toBe("warn");
  });

  it("fails the postgres store when no database URL is set", () => {
    const result = check(runDoctor(env({ PARMANA_NONCE_STORE: "postgres", PARMANA_DATABASE_URL: undefined }), readers), "PARMANA_DATABASE_URL");
    expect(result.level).toBe("fail");
  });

  it("fails an invalid port and timeout together", () => {
    const result = check(runDoctor(env({ PARMANA_SERVICE_PORT: "70000", PARMANA_CONNECTOR_TIMEOUT_MS: "5" }), readers), "port and timeout");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("PARMANA_SERVICE_PORT");
    expect(result.message).toContain("PARMANA_CONNECTOR_TIMEOUT_MS");
  });

  it("never prints a secret value in any message or fix", () => {
    const checks = runDoctor(env({ PARMANA_SERVICE_BEARER_TOKEN: "short" }), readers);
    const text = JSON.stringify(checks);
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(TOKEN);
  });
});
