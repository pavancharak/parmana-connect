import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

export type InputType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface InputField {
  type: InputType;
  required?: boolean;
}

export interface Capability {
  id: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  effect: "read" | "write";
  input?: Record<string, InputField>;
}

export interface Manifest {
  system: string;
  baseUrl: string;
  apiVersion: string;
  credential: {
    type: "bearer" | "header";
    headerName?: string;
    secretRef: string;
  };
  capabilities: Capability[];
}

export interface ManifestError {
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; manifest: Manifest }
  | { ok: false; errors: ManifestError[] };

export interface ValidateOptions {
  /** Allow http:// base URLs. For local tests only. */
  allowInsecureBaseUrl?: boolean;
}

const schemaUrl = new URL("../schema/manifest.schema.json", import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const checkSchema = ajv.compile(JSON.parse(readFileSync(schemaUrl, "utf8")));

/**
 * Parses YAML or JSON text and validates it. YAML aliases are refused and
 * duplicate keys are an error, so a manifest means one thing when read.
 */
export function loadManifest(text: string, options: ValidateOptions = {}): ValidationResult {
  let raw: unknown;
  try {
    raw = parseYaml(text, { maxAliasCount: 0, uniqueKeys: true });
  } catch (err) {
    return { ok: false, errors: [{ path: "", message: `cannot parse: ${(err as Error).message}` }] };
  }
  return validateManifest(raw, options);
}

export function validateManifest(input: unknown, options: ValidateOptions = {}): ValidationResult {
  if (!checkSchema(input)) {
    const errors = (checkSchema.errors ?? []).map((e) => ({
      path: e.instancePath,
      message: e.message ?? "is invalid",
    }));
    return { ok: false, errors };
  }
  const manifest = input as Manifest;
  const errors = semanticChecks(manifest, options);
  return errors.length === 0 ? { ok: true, manifest } : { ok: false, errors };
}

function semanticChecks(m: Manifest, options: ValidateOptions): ManifestError[] {
  const errors: ManifestError[] = [];

  let url: URL | undefined;
  try {
    url = new URL(m.baseUrl);
  } catch {
    errors.push({ path: "/baseUrl", message: "must be an absolute URL" });
  }
  if (url) {
    const insecureOk = options.allowInsecureBaseUrl === true && url.protocol === "http:";
    if (url.protocol !== "https:" && !insecureOk) {
      errors.push({ path: "/baseUrl", message: "must use https://" });
    }
    if (url.username || url.password) {
      errors.push({ path: "/baseUrl", message: "must not contain credentials" });
    }
    if (url.search || url.hash) {
      errors.push({ path: "/baseUrl", message: "must not contain a query or fragment" });
    }
  }

  if (m.credential.type === "header" && !m.credential.headerName) {
    errors.push({ path: "/credential", message: "a header credential needs headerName" });
  }

  const seen = new Set<string>();
  m.capabilities.forEach((cap, i) => {
    const at = `/capabilities/${i}`;
    if (!cap.id.startsWith(`${m.system}:`)) {
      errors.push({ path: `${at}/id`, message: `must start with "${m.system}:"` });
    }
    if (seen.has(cap.id)) {
      errors.push({ path: `${at}/id`, message: `duplicate capability id "${cap.id}"` });
    }
    seen.add(cap.id);

    if (cap.method === "GET" && cap.effect === "write") {
      errors.push({ path: `${at}/effect`, message: "a GET capability cannot be a write" });
    }

    // A read must not send a body or change state: only GET is a read.
    if (cap.effect === "read" && cap.method !== "GET") {
      errors.push({ path: `${at}/method`, message: "a read capability must use GET" });
    }

    const input = cap.input ?? {};
    if (cap.effect === "write" && Object.keys(input).length === 0) {
      errors.push({ path: `${at}/input`, message: "a write capability must declare its input" });
    }

    for (const name of pathParams(cap.path)) {
      const field = input[name];
      if (!field) {
        errors.push({ path: `${at}/path`, message: `path parameter {${name}} has no input declared` });
      } else if (field.required !== true) {
        errors.push({ path: `${at}/input/${name}`, message: `path parameter {${name}} must be required` });
      }
    }
  });

  return errors;
}

function pathParams(path: string): string[] {
  return [...path.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1] ?? "");
}
