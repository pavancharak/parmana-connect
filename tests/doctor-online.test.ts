import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { runOnlineChecks, type OnlineDeps, type OnlinePool } from "../src/doctor-online.js";
import type { Check } from "../src/doctor.js";

const { publicKey: localPublic } = generateKeyPairSync("ed25519");
const localPem = localPublic.export({ type: "spki", format: "pem" }).toString();
const { publicKey: otherPublic } = generateKeyPairSync("ed25519");
const otherPem = otherPublic.export({ type: "spki", format: "pem" }).toString();

const NOW = Date.parse("2026-11-04T12:00:00Z");
const DATE_HEADER = new Date(NOW).toUTCString();
const CORE = "https://core.example.com";
const DB_URL = "postgres://parmana@db.internal:5432/parmana";

function coreResponse(pem: string, dateHeader: string | null = DATE_HEADER, status = 200): Response {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (dateHeader !== null) headers.date = dateHeader;
  return new Response(JSON.stringify({ keyId: "default", algorithm: "ed25519", use: "sig", pem }), { status, headers });
}

function deps(overrides: Partial<OnlineDeps> & { pool?: Partial<OnlinePool> } = {}): OnlineDeps {
  const pool: OnlinePool = {
    query: async (sql: string) => {
      if (sql.startsWith("select to_regclass")) return { rows: [{ present: true }] };
      if (sql.startsWith("select has_table_privilege")) return { rows: [{ ins: true, del: true }] };
      return { rows: [] };
    },
    end: async () => undefined,
    ...overrides.pool,
  };
  return {
    fetch: async () => coreResponse(localPem),
    now: () => NOW,
    readFile: () => localPem,
    createPool: () => pool,
    ...overrides,
  };
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PARMANA_CORE_URL: CORE,
    PARMANA_PUBLIC_KEY_FILE: "/keys/parmana.pem",
    PARMANA_NONCE_STORE: "postgres",
    PARMANA_DATABASE_URL: DB_URL,
    ...overrides,
  };
}

function find(checks: Check[], name: string): Check {
  const found = checks.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found;
}

describe("doctor --online", () => {
  it("passes when the local key matches the core key, the clock is close, and the database works", async () => {
    const checks = await runOnlineChecks(env(), deps());
    expect(checks.filter((check) => check.level === "fail")).toEqual([]);
    expect(find(checks, "parmana-core key").level).toBe("pass");
    expect(find(checks, "clock").level).toBe("pass");
    expect(find(checks, "database").level).toBe("pass");
  });

  it("fails when the local key is not the key parmana-core publishes", async () => {
    const checks = await runOnlineChecks(env(), deps({ fetch: async () => coreResponse(otherPem) }));
    const result = find(checks, "parmana-core key");
    expect(result.level).toBe("fail");
    expect(result.fix).toContain("second channel");
  });

  it("fails when this machine's clock is more than 30 seconds from parmana-core's", async () => {
    const checks = await runOnlineChecks(env(), deps({ now: () => NOW + 120_000 }));
    const result = find(checks, "clock");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("120 seconds");
  });

  it("warns, rather than passes, when parmana-core sends no Date header", async () => {
    const checks = await runOnlineChecks(env(), deps({ fetch: async () => coreResponse(localPem, null) }));
    expect(find(checks, "clock").level).toBe("warn");
  });

  it("fails when parmana-core cannot be reached", async () => {
    const checks = await runOnlineChecks(env(), deps({ fetch: async () => { throw new TypeError("fetch failed"); } }));
    expect(find(checks, "parmana-core").level).toBe("fail");
  });

  it("fails when parmana-core answers with an error status", async () => {
    const checks = await runOnlineChecks(env(), deps({ fetch: async () => coreResponse(localPem, DATE_HEADER, 404) }));
    expect(find(checks, "parmana-core").message).toContain("HTTP 404");
  });

  it("warns when PARMANA_CORE_URL is not set, and does not call the network", async () => {
    let called = false;
    const checks = await runOnlineChecks(env({ PARMANA_CORE_URL: undefined }), deps({ fetch: async () => { called = true; return coreResponse(localPem); } }));
    expect(called).toBe(false);
    expect(find(checks, "parmana-core").level).toBe("warn");
  });

  it("refuses a PARMANA_CORE_URL that is not https", async () => {
    const checks = await runOnlineChecks(env({ PARMANA_CORE_URL: "http://core.example.com" }), deps());
    expect(find(checks, "PARMANA_CORE_URL").level).toBe("fail");
  });

  it("fails when the database cannot be reached, and reports only the error code", async () => {
    const failing = deps({
      createPool: () => ({
        query: async () => {
          throw Object.assign(new Error(`connect failed for ${DB_URL}`), { code: "ECONNREFUSED" });
        },
        end: async () => undefined,
      }),
    });
    const checks = await runOnlineChecks(env(), failing);
    const result = find(checks, "database");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("ECONNREFUSED");
    expect(JSON.stringify(checks)).not.toContain("db.internal");
  });

  it("warns when the database is reachable but the nonce table is missing", async () => {
    const checks = await runOnlineChecks(env(), deps({ pool: { query: async (sql: string) => (sql.startsWith("select to_regclass") ? { rows: [{ present: false }] } : { rows: [] }) } }));
    expect(find(checks, "database").level).toBe("warn");
  });

  it("fails when the database user cannot insert or delete nonces, and writes nothing to check it", async () => {
    const queries: string[] = [];
    const denied = deps({
      pool: {
        query: async (sql: string) => {
          queries.push(sql);
          if (sql.startsWith("select to_regclass")) return { rows: [{ present: true }] };
          if (sql.startsWith("select has_table_privilege")) return { rows: [{ ins: true, del: false }] };
          return { rows: [] };
        },
      },
    });
    const result = find(await runOnlineChecks(env(), denied), "database");
    expect(result.level).toBe("fail");
    expect(result.message).toContain("DELETE: no");
    expect(queries.some((sql) => /\b(insert|delete|update)\b/i.test(sql.replace(/has_table_privilege\(current_user, \$1, '(INSERT|DELETE)'\)/g, "")))).toBe(false);
  });

  it("passes the database check for the memory store, which has no database", async () => {
    const checks = await runOnlineChecks(env({ PARMANA_NONCE_STORE: "memory", PARMANA_DATABASE_URL: undefined }), deps());
    expect(find(checks, "database").level).toBe("pass");
  });
});
