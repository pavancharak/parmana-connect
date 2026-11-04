import { createPublicKey, type KeyObject } from "node:crypto";

import { fingerprintOf } from "./fingerprint.js";
import { loadManifest } from "./manifest.js";

export { fingerprintOf };

/**
 * One check from `doctor`. "pass" means the setting is right, "warn" means it
 * works but needs attention, and "fail" means the service would refuse to run
 * or would refuse every release. A fail always carries a fix.
 */
export interface Check {
  readonly name: string;
  readonly level: "pass" | "warn" | "fail";
  readonly message: string;
  readonly fix?: string;
}

export interface DoctorReaders {
  readonly readFile: (path: string) => string;
  readonly directoryExists: (path: string) => boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const MIN_TOKEN_LENGTH = 32;

/**
 * Runs every check and returns all of them, unlike the service, which stops at
 * the first error. Never prints a secret value: messages name the setting only.
 */
export function runDoctor(env: Env, readers: DoctorReaders): Check[] {
  return [
    checkBearerToken(env),
    checkPolicyDir(env, readers),
    checkPublicKey(env, readers),
    checkManifestAndCredential(env, readers),
    checkAudience(env),
    checkNonceStore(env),
    checkNumbers(env),
    checkClock(),
  ];
}

function checkBearerToken(env: Env): Check {
  const name = "PARMANA_SERVICE_BEARER_TOKEN";
  const token = env[name];
  if (token === undefined || token === "") {
    return { name, level: "fail", message: `${name} is not set`, fix: `Set ${name} to a random value of at least ${MIN_TOKEN_LENGTH} characters, for example the output of: openssl rand -hex 32` };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    return { name, level: "fail", message: `${name} is ${token.length} characters, below the minimum of ${MIN_TOKEN_LENGTH}`, fix: `Replace ${name} with a value of at least ${MIN_TOKEN_LENGTH} characters` };
  }
  return { name, level: "pass", message: `${name} is set and long enough` };
}

function checkPolicyDir(env: Env, readers: DoctorReaders): Check {
  const name = "PARMANA_POLICY_DIR";
  const dir = env[name];
  if (dir === undefined || dir === "") {
    return { name, level: "fail", message: `${name} is not set`, fix: `Set ${name} to an existing folder, such as the folder that holds the policy files` };
  }
  if (!readers.directoryExists(dir)) {
    return { name, level: "fail", message: `${name} points to a folder that does not exist`, fix: `Create the folder named by ${name}, or correct the path` };
  }
  return { name, level: "pass", message: `${name} exists` };
}

function checkPublicKey(env: Env, readers: DoctorReaders): Check {
  const name = "PARMANA_PUBLIC_KEY_FILE";
  const path = env[name];
  if (path === undefined || path === "") {
    return { name, level: "fail", message: `${name} is not set`, fix: `Set ${name} to the path of Parmana's Ed25519 public key in PEM form` };
  }
  let key: KeyObject;
  try {
    key = createPublicKey(readers.readFile(path));
  } catch {
    return { name, level: "fail", message: `${name} cannot be read as a PEM public key`, fix: `Check that the file at ${name} is the PEM public key, with its BEGIN and END lines, and is readable by the service` };
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return { name, level: "fail", message: `${name} is not an Ed25519 key`, fix: `Use Parmana's Ed25519 public key. Other key types are refused` };
  }

  const fingerprint = fingerprintOf(key);
  const expected = env.PARMANA_EXPECTED_KEY_FINGERPRINT;
  if (expected === undefined || expected === "") {
    return { name, level: "warn", message: `key fingerprint is ${fingerprint}, not compared`, fix: "Set PARMANA_EXPECTED_KEY_FINGERPRINT to the fingerprint you pinned, so doctor can compare it" };
  }
  if (expected !== fingerprint) {
    return { name, level: "fail", message: `key fingerprint is ${fingerprint}, which does not match the pinned value`, fix: "The key on disk is not the one you pinned. Check you have the right key. Re-pin only after you have confirmed a rotation through a second channel" };
  }
  return { name, level: "pass", message: `key fingerprint matches the pinned value` };
}

function checkManifestAndCredential(env: Env, readers: DoctorReaders): Check {
  const name = "PARMANA_CONNECTOR_MANIFEST";
  const path = env[name];
  if (path === undefined || path === "") {
    return { name, level: "fail", message: `${name} is not set`, fix: `Set ${name} to the path of the connector manifest, JSON or YAML` };
  }
  let text: string;
  try {
    text = readers.readFile(path);
  } catch {
    return { name, level: "fail", message: `${name} cannot be read`, fix: `Check that the file at ${name} exists and is readable` };
  }
  const result = loadManifest(text);
  if (!result.ok) {
    const first = result.errors[0];
    return { name, level: "fail", message: `manifest is invalid at ${first?.path || "/"}: ${first?.message ?? "invalid"}`, fix: "Correct the manifest at the path shown, then run doctor again" };
  }
  const secret = result.manifest.credential.secretRef;
  if (env[secret] === undefined || env[secret] === "") {
    return { name: "upstream credential", level: "fail", message: `${secret} is not set`, fix: `Set ${secret} to the upstream credential. The service reads it from the environment and never prints it` };
  }
  return { name, level: "pass", message: `manifest is valid and ${secret} is set` };
}

function checkAudience(env: Env): Check {
  const name = "PARMANA_RELEASE_AUDIENCE";
  const value = env[name];
  if (value === undefined || value === "") {
    return { name, level: "fail", message: `${name} is not set, so every release is refused`, fix: `Set ${name} to the exact endpoint URL registered in parmana-core, including https and the path` };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { name, level: "fail", message: `${name} is not an absolute URL`, fix: `Set ${name} to the full https URL, for example https://service.example.com/execute` };
  }
  if (url.protocol !== "https:") {
    return { name, level: "fail", message: `${name} does not use https`, fix: `Change ${name} to https://` };
  }
  const expected = env.PARMANA_EXPECTED_AUDIENCE;
  if (expected !== undefined && expected !== "" && expected !== value) {
    return { name, level: "fail", message: `${name} does not match the URL registered in parmana-core`, fix: `Set ${name} to exactly the registered value, character for character, including any trailing slash` };
  }
  if (expected === undefined || expected === "") {
    return { name, level: "warn", message: `${name} is set, not compared with the registered URL`, fix: "Set PARMANA_EXPECTED_AUDIENCE to the URL registered in parmana-core, so doctor can compare it exactly" };
  }
  return { name, level: "pass", message: `${name} matches the registered URL` };
}

function checkNonceStore(env: Env): Check {
  const name = "PARMANA_NONCE_STORE";
  const raw = env[name];
  if (raw === "memory") {
    return { name, level: "warn", message: "memory store: replay protection is not shared between instances", fix: "Use postgres for any deployment with more than one instance" };
  }
  if (raw !== undefined && raw !== "" && raw !== "postgres") {
    return { name, level: "fail", message: `${name} must be postgres or memory`, fix: `Set ${name} to postgres` };
  }
  if (env.PARMANA_DATABASE_URL === undefined || env.PARMANA_DATABASE_URL === "") {
    return { name: "PARMANA_DATABASE_URL", level: "fail", message: "PARMANA_DATABASE_URL is not set, and the postgres store needs it", fix: "Set PARMANA_DATABASE_URL to the connection string of the replay database. For a local test only, set PARMANA_NONCE_STORE=memory" };
  }
  return { name, level: "pass", message: "postgres store is configured" };
}

function checkNumbers(env: Env): Check {
  const problems: string[] = [];
  const port = env.PARMANA_SERVICE_PORT ?? "8080";
  if (!isIntegerIn(port, 1, 65535)) problems.push("PARMANA_SERVICE_PORT must be an integer from 1 to 65535");
  const timeout = env.PARMANA_CONNECTOR_TIMEOUT_MS ?? "10000";
  if (!isIntegerIn(timeout, 100, 120000)) problems.push("PARMANA_CONNECTOR_TIMEOUT_MS must be an integer from 100 to 120000");
  if (problems.length > 0) {
    return { name: "port and timeout", level: "fail", message: problems.join("; "), fix: "Correct the value shown, then run doctor again" };
  }
  return { name: "port and timeout", level: "pass", message: "port and timeout are valid" };
}

function checkClock(): Check {
  return {
    name: "clock",
    level: "warn",
    message: `doctor cannot check the clock offline. Current UTC time is ${new Date().toISOString()}`,
    fix: "Confirm the host clock is within 30 seconds of a reliable time source. A release outside that window is refused",
  };
}

function isIntegerIn(raw: string, min: number, max: number): boolean {
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max;
}
