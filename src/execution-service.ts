import { timingSafeEqual, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { ExecutableContentHasher, CryptoBootstrap } from "@parmana/crypto";
import { EnvelopeVerifier, MemoryNonceStore, type NonceStore } from "@parmana/envelope-verifier";
import { toExecutableContent, type SignedExecutionAuthorization } from "@parmana/shared";

import { ConnectorError, type GenericConnector } from "./connector.js";
import {
  isSignedExternalRelease,
  verifyExternalRelease,
  type ExternalRelease,
  type SignedExternalRelease,
} from "./external-release.js";

/** Largest result parmana-core accepts from an external endpoint, in bytes. */
const EXTERNAL_RESULT_LIMIT_BYTES = 16 * 1024;

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
  /**
   * This endpoint's URL exactly as it is registered in parmana-core, for
   * example https://parmana-connect.onrender.com/execute. A signed release
   * is refused unless its audience equals this value. Unset, the service
   * refuses signed releases with 503.
   */
  readonly releaseAudience?: string | undefined;
  /**
   * When true, a bearer token plus a signed authorization is refused. Only a
   * signed release from parmana-core runs. Defaults to false.
   */
  readonly releaseOnly?: boolean | undefined;
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
  const releaseNonceStore = options.nonceStore ?? new MemoryNonceStore();
  const verifier = new EnvelopeVerifier({
    publicKey: options.publicKey,
    nonceStore: releaseNonceStore,
  });
  const hasher = new ExecutableContentHasher(CryptoBootstrap.create());
  const expectedAuthorization = Buffer.from(`Bearer ${options.bearerToken}`);

  const handleExternalRelease = async (body: SignedExternalRelease, res: ServerResponse): Promise<void> => {
    if (options.releaseAudience === undefined) {
      return send(res, 503, { error: "this endpoint has no release audience configured" });
    }

    // No bearer token here: the signature is the authentication.
    const check = await verifyExternalRelease(body, {
      publicKey: options.publicKey,
      audience: options.releaseAudience,
      capabilities: options.connector.capabilities,
      now: new Date(),
      nonceStore: releaseNonceStore,
    });
    if (!check.valid) {
      return send(res, 403, { error: "release refused", errors: check.errors });
    }

    return answerRelease(check.release, res);
  };

  const answerRelease = async (release: ExternalRelease, res: ServerResponse): Promise<void> => {
    let success: boolean;
    let result: Record<string, unknown>;

    try {
      const response = await options.connector.execute(
        { capability: release.capability, parameters: release.parameters as Record<string, unknown> },
        {
          credential: {
            providerId: "execution-service",
            credentialId: options.credentialId,
            value: options.resolveCredential(),
          },
          timeoutMs: options.timeoutMs ?? 10_000,
        },
      );
      success = response.success;
      result = { status: response.metadata.status, body: response.metadata.body };
    } catch (err) {
      success = false;
      result = { error: connectorMessage(err) };
    }

    // parmana-core refuses a result above 16 KB. Say so here rather than let it fail there.
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > EXTERNAL_RESULT_LIMIT_BYTES) {
      success = false;
      result = { error: "result is larger than 16 KB" };
    }

    return send(res, 200, {
      businessTransactionId: release.businessTransactionId,
      capability: release.capability,
      success,
      result,
      executedAt: new Date().toISOString(),
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Reports that the process is up. It reads no settings and checks nothing upstream.
    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { status: "UP" });
    }
    if (req.method !== "POST" || req.url !== "/execute") {
      return send(res, 404, { error: "not found" });
    }

    const body = await readJson(req, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    if (body === undefined) {
      return send(res, 400, { error: "request body must be JSON within the size limit" });
    }

    if (isSignedExternalRelease(body)) {
      return handleExternalRelease(body, res);
    }

    if (options.releaseOnly === true) {
      return send(res, 403, { error: "release-only: send a signed release from parmana-core" });
    }

    if (!isAuthorized(req, expectedAuthorization)) {
      return send(res, 401, { error: "unauthorized" });
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
