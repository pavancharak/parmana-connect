import { createPublicKey } from "node:crypto";

import type { Check } from "./doctor.js";
import { fingerprintOf } from "./fingerprint.js";
import { NONCE_TABLE } from "./postgres-nonce-store.js";

/** The most a clock may differ from parmana-core's before a release is at risk. */
const MAX_CLOCK_SKEW_MS = 30_000;

export interface OnlineDeps {
  readonly fetch: (url: string) => Promise<Response>;
  readonly now: () => number;
  readonly readFile: (path: string) => string;
  readonly createPool: (connectionString: string) => OnlinePool;
}

/** The part of a database pool that doctor uses. Kept small so tests can supply a fake. */
export interface OnlinePool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Checks that need the network or the database: the key parmana-core publishes,
 * this machine's clock against parmana-core's, and the replay database.
 * Each check is skipped with a warning, not a failure, when its setting is unset.
 */
export async function runOnlineChecks(env: Env, deps: OnlineDeps): Promise<Check[]> {
  return [...(await checkAgainstCore(env, deps)), await checkDatabase(env, deps)];
}

async function checkAgainstCore(env: Env, deps: OnlineDeps): Promise<Check[]> {
  const base = env.PARMANA_CORE_URL;
  if (base === undefined || base === "") {
    return [
      {
        name: "parmana-core",
        level: "warn",
        message: "not checked: PARMANA_CORE_URL is not set, so the key and the clock were not compared",
        fix: "Set PARMANA_CORE_URL to parmana-core's base URL, for example https://parmana-api-real.vercel.app, and run doctor with --online again",
      },
    ];
  }
  let root: URL;
  try {
    root = new URL(base);
  } catch {
    return [{ name: "PARMANA_CORE_URL", level: "fail", message: "PARMANA_CORE_URL is not an absolute URL", fix: "Set it to the full https URL of parmana-core" }];
  }
  if (root.protocol !== "https:") {
    return [{ name: "PARMANA_CORE_URL", level: "fail", message: "PARMANA_CORE_URL does not use https", fix: "Change it to https://" }];
  }

  const keyId = env.PARMANA_CORE_KEY_ID === undefined || env.PARMANA_CORE_KEY_ID === "" ? "default" : env.PARMANA_CORE_KEY_ID;
  const url = `${root.origin}/keys/${encodeURIComponent(keyId)}`;

  let response: Response;
  try {
    response = await deps.fetch(url);
  } catch (err) {
    // Node wraps the cause. Report its code only, which names the reason without the URL.
    const cause = (err as { cause?: { code?: unknown }; code?: unknown }).cause?.code ?? (err as { code?: unknown }).code;
    const code = typeof cause === "string" ? cause : "unknown";
    return [
      {
        name: "parmana-core",
        level: "fail",
        message: `cannot reach parmana-core from Node.js (error ${code})`,
        fix: "A browser or PowerShell may reach it while Node cannot. Check for a proxy or a certificate that Node does not trust, then run doctor with --online again",
      },
    ];
  }
  if (!response.ok) {
    return [{ name: "parmana-core", level: "fail", message: `parmana-core answered with HTTP ${response.status} for key ${keyId}`, fix: "Check PARMANA_CORE_KEY_ID, or that the key is published on this deployment" }];
  }

  const checks: Check[] = [];
  const core = await readCoreKey(response);
  if (core === undefined) {
    checks.push({ name: "parmana-core key", level: "fail", message: "parmana-core's response does not contain a valid Ed25519 public key", fix: "Check that PARMANA_CORE_URL is the parmana-core API, not another site" });
  } else {
    checks.push(compareWithLocalKey(core, env, deps));
  }
  checks.push(checkClock(response.headers.get("date"), deps.now()));
  return checks;
}

async function readCoreKey(response: Response) {
  try {
    const body = (await response.json()) as { pem?: unknown };
    if (typeof body.pem !== "string") return undefined;
    const key = createPublicKey(body.pem);
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

function compareWithLocalKey(core: ReturnType<typeof createPublicKey>, env: Env, deps: OnlineDeps): Check {
  const name = "parmana-core key";
  const path = env.PARMANA_PUBLIC_KEY_FILE;
  if (path === undefined || path === "") {
    return { name, level: "warn", message: `parmana-core publishes ${fingerprintOf(core)}, not compared: PARMANA_PUBLIC_KEY_FILE is not set`, fix: "Set PARMANA_PUBLIC_KEY_FILE so doctor can compare the two keys" };
  }
  let local: ReturnType<typeof createPublicKey>;
  try {
    local = createPublicKey(deps.readFile(path));
  } catch {
    return { name, level: "warn", message: "not compared: PARMANA_PUBLIC_KEY_FILE cannot be read", fix: "Fix PARMANA_PUBLIC_KEY_FILE, then run doctor with --online again" };
  }
  if (fingerprintOf(local) !== fingerprintOf(core)) {
    return {
      name,
      level: "fail",
      message: `the key in PARMANA_PUBLIC_KEY_FILE (${fingerprintOf(local)}) is not the key parmana-core publishes (${fingerprintOf(core)})`,
      fix: "Use the key parmana-core publishes. If the key was rotated, confirm the new fingerprint through a second channel first",
    };
  }
  return { name, level: "pass", message: "the local key matches the key parmana-core publishes" };
}

function checkClock(dateHeader: string | null, nowMs: number): Check {
  const name = "clock";
  const serverMs = dateHeader === null ? NaN : Date.parse(dateHeader);
  if (Number.isNaN(serverMs)) {
    return { name, level: "warn", message: "parmana-core did not send a usable Date header, so the clock was not compared", fix: "Check the clock against a reliable time source by hand" };
  }
  const skew = Math.abs(nowMs - serverMs);
  const seconds = Math.round(skew / 1000);
  if (skew > MAX_CLOCK_SKEW_MS) {
    return {
      name,
      level: "fail",
      message: `this machine's clock differs from parmana-core's by about ${seconds} seconds. Releases outside 30 seconds are refused`,
      fix: "Turn on automatic time sync (NTP, or Windows Time), then run doctor with --online again",
    };
  }
  return { name, level: "pass", message: `this machine's clock is within ${seconds} seconds of parmana-core's` };
}

async function checkDatabase(env: Env, deps: OnlineDeps): Promise<Check> {
  const name = "database";
  if (env.PARMANA_NONCE_STORE === "memory") {
    return { name, level: "pass", message: "memory store: no database to check" };
  }
  const url = env.PARMANA_DATABASE_URL;
  if (url === undefined || url === "") {
    return { name, level: "warn", message: "not checked: PARMANA_DATABASE_URL is not set" };
  }
  const pool = deps.createPool(url);
  try {
    await pool.query("select 1");
    const result = await pool.query("select to_regclass($1) is not null as present", [NONCE_TABLE]);
    const present = (result.rows[0] as { present?: unknown } | undefined)?.present === true;
    if (!present) {
      return { name, level: "warn", message: `reachable, but the ${NONCE_TABLE} table does not exist yet`, fix: "The service creates it on first start. Start it once, or run npm run migrate" };
    }
    // Read the grants only. No rows are written, so this is safe on a live database.
    const grants = await pool.query(
      "select has_table_privilege(current_user, $1, 'INSERT') as ins, has_table_privilege(current_user, $1, 'DELETE') as del",
      [NONCE_TABLE],
    );
    const row = (grants.rows[0] ?? {}) as { ins?: unknown; del?: unknown };
    if (row.ins !== true || row.del !== true) {
      return {
        name,
        level: "fail",
        message: `reachable, but the database user cannot insert and delete rows in ${NONCE_TABLE} (INSERT: ${row.ins === true ? "yes" : "no"}, DELETE: ${row.del === true ? "yes" : "no"})`,
        fix: `Grant INSERT and DELETE on ${NONCE_TABLE} to the user in PARMANA_DATABASE_URL. Without them every release is refused`,
      };
    }
    return { name, level: "pass", message: `reachable, and the ${NONCE_TABLE} table exists with INSERT and DELETE granted` };
  } catch (err) {
    // Report the error code only. The message can contain the host, and the URL holds the password.
    const code = typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "unknown";
    return {
      name,
      level: "fail",
      message: `cannot use the database (error ${code})`,
      fix: "Check PARMANA_DATABASE_URL, that the database accepts connections from this machine, and its TLS settings",
    };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
