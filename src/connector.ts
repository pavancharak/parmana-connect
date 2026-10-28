import { validateManifest, type Capability, type InputField, type Manifest, type ValidateOptions } from "./manifest.js";

/**
 * Shapes mirror @parmana/connector-sdk. A caller resolves the credential and
 * passes it in; this connector never looks up secrets itself.
 */
export interface CredentialHandle {
  readonly providerId: string;
  readonly credentialId: string;
  readonly value: string;
}

export interface ConnectorRequest {
  readonly capability: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface ConnectorExecutionContext {
  readonly credential: CredentialHandle;
  readonly timeoutMs: number;
}

export interface ConnectorResponse {
  readonly success: true;
  readonly metadata: { readonly status: number; readonly body: unknown };
}

export type ConnectorErrorCode =
  | "unknown_capability"
  | "invalid_input"
  | "credential_invalid"
  | "upstream_error"
  | "timeout";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;

  constructor(code: ConnectorErrorCode, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
  }
}

export interface GenericConnectorOptions extends ValidateOptions {
  /** Upper bound on the upstream request, in milliseconds. */
  readonly defaultTimeoutMs?: number;
  /** Upper bound on the response body read, in bytes. */
  readonly maxResponseBytes?: number;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: typeof fetch;
}

export interface GenericConnector {
  readonly system: string;
  /** Every capability in the manifest, read and write. */
  readonly capabilities: readonly string[];
  execute(request: ConnectorRequest, context: ConnectorExecutionContext): Promise<ConnectorResponse>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
/** Methods whose non-path inputs travel in a JSON body; the rest use the query string. */
const BODY_METHODS = new Set<Capability["method"]>(["POST", "PUT", "PATCH"]);

/**
 * Builds a connector from a manifest. The manifest is validated here, so an
 * invalid one never reaches the network.
 */
export function createGenericConnector(manifest: unknown, options: GenericConnectorOptions = {}): GenericConnector {
  const result = validateManifest(manifest, options);
  if (!result.ok) {
    const first = result.errors[0];
    throw new ConnectorError("invalid_input", `invalid manifest at ${first?.path || "/"}: ${first?.message ?? "invalid"}`);
  }
  const m: Manifest = result.manifest;
  const byId = new Map(m.capabilities.map((cap) => [cap.id, cap]));
  const doFetch = options.fetch ?? fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    system: m.system,
    capabilities: Object.freeze(m.capabilities.map((cap) => cap.id)),

    async execute(request, context) {
      const cap = byId.get(request.capability);
      if (!cap) {
        throw new ConnectorError("unknown_capability", `capability "${request.capability}" is not in this manifest`);
      }

      // Every input is checked before the request is built, so a bad call never reaches the network.
      const params = checkInput(cap, request.parameters);
      const token = checkCredential(m, context.credential);
      const { url, body: requestBody } = buildRequest(m.baseUrl, cap, params);
      const headers = new Headers({ Accept: "application/json" });
      if (m.credential.type === "bearer") {
        headers.set("Authorization", `Bearer ${token}`);
      } else {
        headers.set(m.credential.headerName ?? "Authorization", token);
      }
      if (requestBody !== undefined) {
        headers.set("Content-Type", "application/json");
      }

      const timeoutMs = context.timeoutMs > 0 ? context.timeoutMs : defaultTimeoutMs;
      let response: Response;
      try {
        response = await doFetch(url, {
          method: cap.method,
          headers,
          body: requestBody ?? null,
          // Never follow a redirect: the credential must not reach another host.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw toTransportError(err, timeoutMs);
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new ConnectorError("upstream_error", `${cap.id} returned status ${response.status}`);
      }

      const body = await readBody(response, maxBytes);
      return { success: true, metadata: { status: response.status, body } };
    },
  };
}

function checkInput(cap: Capability, parameters: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const declared = cap.input ?? {};
  for (const name of Object.keys(parameters)) {
    if (!Object.prototype.hasOwnProperty.call(declared, name)) {
      throw new ConnectorError("invalid_input", `${cap.id}: input "${name}" is not declared`);
    }
  }
  for (const [name, field] of Object.entries(declared)) {
    const value = parameters[name];
    if (value === undefined) {
      if (field.required === true) {
        throw new ConnectorError("invalid_input", `${cap.id}: input "${name}" is required`);
      }
      continue;
    }
    if (!matchesType(value, field)) {
      throw new ConnectorError("invalid_input", `${cap.id}: input "${name}" must be ${field.type}`);
    }
  }
  return { ...parameters };
}

function matchesType(value: unknown, field: InputField): boolean {
  switch (field.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

function checkCredential(m: Manifest, credential: CredentialHandle): string {
  if (typeof credential?.value !== "string" || credential.value.length === 0) {
    // Name the reference, never the value.
    throw new ConnectorError("credential_invalid", `credential ${m.credential.secretRef} is missing or empty`);
  }
  return credential.value;
}

/**
 * Fills {path} parameters (URL-encoded). The remaining declared inputs go in
 * a JSON body for POST, PUT and PATCH, and in the query string otherwise.
 */
function buildRequest(baseUrl: string, cap: Capability, params: Record<string, unknown>): { url: string; body: string | undefined } {
  const remaining = { ...params };
  const path = cap.path.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
    const value = remaining[name];
    delete remaining[name];
    return encodeURIComponent(String(value));
  });

  const url = new URL(baseUrl.replace(/\/$/, "") + path);
  if (BODY_METHODS.has(cap.method)) {
    const body: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(remaining)) {
      if (value !== undefined) body[name] = value;
    }
    return { url: url.toString(), body: JSON.stringify(body) };
  }

  for (const [name, value] of Object.entries(remaining)) {
    if (value === undefined) continue;
    url.searchParams.set(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  return { url: url.toString(), body: undefined };
}

function toTransportError(err: unknown, timeoutMs: number): ConnectorError {
  const name = (err as { name?: string } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new ConnectorError("timeout", `no response within ${timeoutMs} ms`);
  }
  if (err instanceof TypeError) {
    // fetch raises TypeError for network failures and for redirects under redirect: "error".
    return new ConnectorError("upstream_error", "request failed or was redirected; redirects are refused");
  }
  return new ConnectorError("upstream_error", "request failed");
}

async function readBody(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readLimited(response, maxBytes);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorError("upstream_error", "response declared JSON but did not parse");
  }
}

/** Reads the body, stopping as soon as it passes maxBytes. */
async function readLimited(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream_error", `response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
