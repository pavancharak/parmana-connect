import { existsSync, readFileSync, statSync } from "node:fs";

import { runDoctor, type Check } from "./doctor.js";

/**
 * Checks the environment the execution service would start with, and prints
 * every problem with its fix. Exits 0 when nothing fails, 1 when something does.
 * It reads the same variables as the service and never prints their values.
 */
const checks = runDoctor(process.env, {
  readFile: (path) => readFileSync(path, "utf8"),
  directoryExists: (path) => existsSync(path) && statSync(path).isDirectory(),
});

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
process.exit(failures > 0 ? 1 : 0);
