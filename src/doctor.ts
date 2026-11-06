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
  /** Names of the entries in a folder. Empty when the folder cannot be read. */
  readonly listDirectory: (path: string) => string[];
  /** The major version of the Node.js running doctor. */
  readonly nodeMajor: number;
}

type Env = Readonly<Record<string, string | undefined>>;

const MIN_TOKEN_LENGTH = 32;
const MIN_DISTINCT_TOKEN_CHARACTERS = 8;
const REQUIRED_NODE_MAJOR = 24;

/**
 * Every PARMANA_ name that any Parmana component reads. Names outside this list
 * are reported, because a misspelt setting is otherwise ignored without a word.
 * The MCP and test settings are included so they are not flagged here.
 */
export const KNOWN_SETTINGS: readonly string[] = [
  // connector service
  "PARMANA_SERVICE_BEARER_TOKEN",
  "PARMANA_POLICY_DIR",
  "PARMANA_PUBLIC_KEY_FILE",
  "PARMANA_CONNECTOR_MANIFEST",
  "PARMANA_CONNECTOR_TIMEOUT_MS",
  "PARMANA_NONCE_STORE",
  "PARMANA_DATABASE_URL",
  "PARMANA_RELEASE_AUDIENCE",
  "PARMANA_RELEASE_ONLY",
  "PARMANA_SERVICE_PORT",
  "PARMANA_SERVICE_HOST",
  // doctor pins and online checks
  "PARMANA_EXPECTED_KEY_FINGERPRINT",
  "PARMANA_EXPECTED_AUDIENCE",
  "PARMANA_CORE_URL",
  "PARMANA_CORE_KEY_ID",
  // MCP server
  "PARMANA_API_URL",
  "PARMANA_API_KEY",
  "PARMANA_AUTHORITY_ID",
  "PARMANA_AUTHORITY_TYPE",
  "PARMANA_PRINCIPAL_ID",
  "PARMANA_AUTHORIZATION_ID",
  "PARMANA_AUTHORIZATION_PURPOSE",
  "PARMANA_SOURCE_SYSTEM",
  "PARMANA_SUBMITTED_BY",
  // tests
  "PARMANA_TEST_DATABASE_URL",
];

/**
 * Runs every check and returns all of them, unlike the service, which stops at
 * the first error. Never prints a secret value: messages name the setting only.
 */
export function runDoctor(env: Env, readers: DoctorReaders): Check[] {
  return [
    checkNodeVersion(readers),
    checkBearerToken(env),
    checkPolicyDir(env, readers),
    checkPublicKey(env, readers),
    checkManifestAndCredential(env, readers),
    checkAudience(env),
    checkNonceStore(env),
    checkNumbers(env),
    ...checkUnknownSettings(env),
    checkClock(),
  ];
}

function checkNodeVersion(readers: DoctorReaders): Check {
  const name = "Node.js";
  if (readers.nodeMajor < REQUIRED_NODE_MAJOR) {
    return { name, level: "fail", message: `Node.js ${readers.nodeMajor} is running, and the service needs ${REQUIRED_NODE_MAJOR} or later`, fix: `Install Node.js ${REQUIRED_NODE_MAJOR} or later, then run npm ci again` };
  }
  return { name, level: "pass", message: `Node.js ${readers.nodeMajor}` };
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
  const distinct = new Set(token).size;
  if (distinct < MIN_DISTINCT_TOKEN_CHARACTERS) {
    return { name, level: "fail", message: `${name} uses only ${distinct} different characters, so it is not random enough`, fix: `Replace ${name} with a random value, for example the output of: openssl rand -hex 32` };
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
  let text: string;
  try {
    text = readers.readFile(path);
  } catch {
    return { name, level: "fail", message: `${name} cannot be read`, fix: `Check that the file at ${name} exists and is readable by the service` };
  }
  if (/PRIVATE KEY/.test(text)) {
    return { name, level: "fail", message: `${name} contains a private key. The service needs only the public key`, fix: "Remove the private key from this machine, and point the setting at the public key only. Treat the private key as compromised and replace it" };
  }
  let key: KeyObject;
  try {
    key = createPublicKey(text);
  } catch {
    return { name, level: "fail", message: `${name} cannot be read as a PEM public key`, fix: `Check that the file at ${name} is the PEM public key, with its BEGIN and END lines` };
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return { name, level: "fail", message: `${name} is not an Ed25519 key`, fix: "Use Parmana's Ed25519 public key. Other key types are refused" };
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

/**
 * A PARMANA_ setting that no component reads is almost always a typo, and the
 * service ignores it silently. Each one is reported with the closest real name.
 */
function checkUnknownSettings(env: Env): Check[] {
  const known = new Set(KNOWN_SETTINGS);
  const unknown = Object.keys(env).filter((key) => key.startsWith("PARMANA_") && !known.has(key) && env[key] !== undefined);
  return unknown.map((key) => {
    const closest = closestSetting(key);
    return {
      name: key,
      level: "warn" as const,
      message: closest === undefined ? `${key} is not a setting any Parmana component reads, so it has no effect` : `${key} is not a setting any Parmana component reads. Did you mean ${closest}?`,
      fix: closest === undefined ? "Remove it, or correct its name" : `Rename ${key} to ${closest}, or remove it`,
    };
  });
}

/** The known setting within two edits of the given name, if there is one. */
export function closestSetting(name: string): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of KNOWN_SETTINGS) {
    const distance = editDistance(name, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current.push(Math.min((current[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, (previous[j - 1] ?? 0) + cost));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
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
