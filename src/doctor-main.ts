import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { Pool } from "pg";

import { runDoctor, type Check } from "./doctor.js";
import { runOnlineChecks, type OnlinePool } from "./doctor-online.js";

/**
 * Checks the environment the execution service would start with, and prints
 * every problem with its fix. Exits 0 when nothing fails, 1 when something does.
 * It reads the same variables as the service and never prints their values.
 *
 * With --online it also checks parmana-core's key and clock, and the database.
 */
async function main(): Promise<number> {
  const online = process.argv.includes("--online");
  const offline = runDoctor(process.env, {
    readFile: (path) => readFileSync(path, "utf8"),
    directoryExists: (path) => existsSync(path) && statSync(path).isDirectory(),
    listDirectory: (path) => {
      try {
        return readdirSync(path);
      } catch {
        return [];
      }
    },
    nodeMajor: Number(process.versions.node.split(".")[0]),
  });
  // With --online, the clock is compared against parmana-core, so the offline "cannot check" warning is dropped.
  const checks: Check[] = online ? offline.filter((check) => check.name !== "clock") : offline;

  if (online) {
    checks.push(
      ...(await runOnlineChecks(process.env, {
        fetch: (url) => fetch(url, { signal: AbortSignal.timeout(10_000) }),
        now: () => Date.now(),
        readFile: (path) => readFileSync(path, "utf8"),
        createPool: (connectionString): OnlinePool => {
          const pool = new Pool({ connectionString, connectionTimeoutMillis: 5000 });
          return {
            query: async (sql, params) => {
              const result = await pool.query(sql, params as unknown[] | undefined);
              return { rows: result.rows };
            },
            end: () => pool.end(),
          };
        },
      })),
    );
  }

  const LABEL: Record<Check["level"], string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  for (const check of checks) {
    console.log(`[${LABEL[check.level]}] ${check.name}: ${check.message}`);
    if (check.fix !== undefined && check.level !== "pass") {
      console.log(`       fix: ${check.fix}`);
    }
  }

  const failures = checks.filter((check) => check.level === "fail").length;
  const warnings = checks.filter((check) => check.level === "warn").length;
  console.log(`\n${failures} failing, ${warnings} to review`);
  return failures > 0 ? 1 : 0;
}

// Set the exit code and let the process end on its own. Calling process.exit() while
// a fetch connection is still closing triggers a libuv assertion on Windows.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(`doctor could not run: ${err instanceof Error ? err.message : "unknown error"}`);
    process.exitCode = 1;
  });
