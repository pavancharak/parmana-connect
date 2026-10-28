import { timingSafeEqual, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ExecutableContentHasher, CryptoBootstrap } from "@parmana/crypto";
import { EnvelopeVerifier, MemoryNonceStore, type NonceStore } from "@parmana/envelope-verifier";
import { toExecutableContent, type SignedExecutionAuthorization } from "@parmana/shared";

import { ConnectorError, type GenericConnector } from "./connector.js";

/**
 * Receiving side of a Parmana authorization. parmana-core's HttpExecutionSystem
 * POSTs an approved ExecutionRequest to /execute. This service refuses anything
 * that is not authorized by Parmana, and only then runs its connector.
 *
 * Checks, in order: bearer token, the signed envelope (signature, expiry,
 * TTL, single use nonce), the transaction hash recomputed from the request,
 * and that the authorization was granted for this exact action.
 */
export interface ExecutionServiceOptions {
  /** Shared secret that parmana-core presents as a bearer token. */
  readonly bearerToken: string;
  /** Parmana's public key, the one that signs authorizations. */
  readonly publicKey: KeyObject;
  readonly connector: GenericConnector;
  /** Returns the connector's secret value. It is read per request and never logged. */
  readonly resolveCredential: () => string;
  /** Name of the credential reference, for error messages and the credential handle. */
  readonly credentialId: string;
  readonly timeoutMs?: number;
  /** Must be shared across instances to prevent replay across them. */
  readonly nonceStore?: NonceStore | undefined;
  readonly maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface ExecutionServiceRequest {
  readonly businessTransactionId: string;
  readonly action: string;
  readonly target: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly authorization: SignedExecutionAuthorization;
}

export function createExecutionService(options: ExecutionServiceOptions) {
  const verifier = new EnvelopeVerifier({
    publicKey: options.publicKey,
    nonceStore: options.nonceStore ?? new MemoryNonceStore(),
  });
  const hasher = new ExecutableContentHasher(CryptoBootstrap.create());
  const expectedAuthorization = Buffer.from(`Bearer ${options.bearerToken}`);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST" || req.url !== "/execute") {
      return send(res, 404, { error: "not found" });
    }
    if (!isAuthorized(req, expectedAuthorization)) {
      return send(res, 401, { error: "unauthorized" });
    }

    const body = await readJson(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (body === undefined) {
      return send(res, 400, { error: "request body must be JSON within the size limit" });
    }
    if (body.authorization === undefined) {
      return send(res, 401, { error: "authorization required" });
    }
    const request = asExecutionRequest(body);
    if (request === undefined) {
      return send(res, 400, { error: "request is missing a required field" });
    }

    // Signature, expiry, TTL and the nonce. The nonce is consumed here.
    const envelope = await verifier.verify(request.authorization);
    if (!envelope.valid) {
      return send(res, 403, { error: "authorization invalid", checks: envelope.checks });
    }

    let content;
    try {
      content = toExecutableContent({
        businessTransactionId: request.businessTransactionId,
        action: request.action,
        target: request.target,
        parameters: request.parameters,
      });
    } catch {
      return send(res, 400, { error: "request content is invalid" });
    }
    const actualHash = await hasher.hash(content);
    if (actualHash !== request.authorization.payload.businessTransactionHash) {
      return send(res, 403, {
        error: "authorization invalid",
        checks: { businessTransactionHashMatches: false },
      });
    }

    // Fail closed: the authorization must name this action.
    if (request.authorization.payload.grantedCapability !== request.action) {
      return send(res, 403, { error: "authorization does not cover this action" });
    }

    try {
      const response = await options.connector.execute(
        { capability: request.action, parameters: request.parameters },
        {
          credential: {
            providerId: "execution-service",
            credentialId: options.credentialId,
            value: options.resolveCredential(),
          },
          timeoutMs: options.timeoutMs ?? 10_000,
        },
      );
      return send(res, 200, {
        businessTransactionId: request.businessTransactionId,
        action: request.action,
        target: request.target,
        parameters: request.parameters,
        success: response.success,
        executedAt: new Date().toISOString(),
        metadata: response.metadata,
      });
    } catch (err) {
      return send(res, connectorStatus(err), { error: connectorMessage(err) });
    }
  };

  return {
    handle,
    listen(port: number, host = "127.0.0.1"): Promise<Server> {
      const server = createServer((req, res) => {
        handle(req, res).catch(() => send(res, 500, { error: "internal error" }));
      });
      return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
    },
  };
}

function isAuthorized(req: IncomingMessage, expected: Buffer): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) return undefined;
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asExecutionRequest(body: Record<string, unknown>): ExecutionServiceRequest | undefined {
  const { businessTransactionId, action, target, parameters, authorization } = body;
  if (
    typeof businessTransactionId !== "string" ||
    typeof action !== "string" ||
    typeof target !== "string" ||
    typeof parameters !== "object" ||
    parameters === null ||
    Array.isArray(parameters) ||
    typeof authorization !== "object" ||
    authorization === null
  ) {
    return undefined;
  }
  return {
    businessTransactionId,
    action,
    target,
    parameters: parameters as Record<string, unknown>,
    authorization: authorization as SignedExecutionAuthorization,
  };
}

function connectorStatus(err: unknown): number {
  if (err instanceof ConnectorError) {
    switch (err.code) {
      case "unknown_capability":
      case "invalid_input":
        return 422;
      case "upstream_error":
      case "timeout":
        return 502;
      default:
        return 500;
    }
  }
  return 500;
}

function connectorMessage(err: unknown): string {
  // Only the connector's own code and summary, never a secret or an upstream body.
  return err instanceof ConnectorError ? `connector failed: ${err.code}` : "connector failed";
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
