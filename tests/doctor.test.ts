import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { closestSetting, fingerprintOf, runDoctor, type Check } from "../src/doctor.js";

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

// Generated at run time, so no token-shaped literal is committed.
const TOKEN = randomBytes(16).toString("hex");
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
  listDirectory: (path: string) => (path === "/policies" ? ["policy.json"] : []),
  nodeMajor: 24,
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

  it("fails when the file at PARMANA_PUBLIC_KEY_FILE holds a private key", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const withPrivate = { ...readers, readFile: (path: string) => (path === "/keys/parmana.pem" ? pem : readers.readFile(path)) };
    const result = check(runDoctor(env(), withPrivate), "PARMANA_PUBLIC_KEY_FILE");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("private key");
    expect(JSON.stringify(result)).not.toContain(pem.split("\n")[1] ?? "");
  });

  it("fails a bearer token with too few different characters", () => {
    const result = check(runDoctor(env({ PARMANA_SERVICE_BEARER_TOKEN: "ab".repeat(16) }), readers), "PARMANA_SERVICE_BEARER_TOKEN");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("not random enough");
  });

  it("passes an existing policy folder whether or not it has files, because the service only needs it to exist", () => {
    const empty = { ...readers, listDirectory: () => [] };
    expect(check(runDoctor(env(), empty), "PARMANA_POLICY_DIR").level).toBe("pass");
  });

  it("fails when Node.js is older than 24", () => {
    const old = { ...readers, nodeMajor: 22 };
    expect(check(runDoctor(env(), old), "Node.js").level).toBe("fail");
  });

  it("reports a misspelt PARMANA_ setting and suggests the real name", () => {
    const checks = runDoctor(env({ PARMANA_SERVICE_PORTT: "8080" }), readers);
    const result = check(checks, "PARMANA_SERVICE_PORTT");
    expect(result.level).toBe("warn");
    expect(result.message).toContain("Did you mean PARMANA_SERVICE_PORT?");
  });

  it("does not flag the MCP server settings", () => {
    const checks = runDoctor(env({ PARMANA_API_URL: "https://api.example.com", PARMANA_AUTHORITY_TYPE: "USER" }), readers);
    expect(checks.some((item) => item.name === "PARMANA_API_URL")).toBe(false);
    expect(checks.some((item) => item.name === "PARMANA_AUTHORITY_TYPE")).toBe(false);
  });

  it("suggests nothing for a name far from every real setting", () => {
    expect(closestSetting("PARMANA_COMPLETELY_UNRELATED_THING")).toBeUndefined();
  });
});
