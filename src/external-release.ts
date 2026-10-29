import { verify, type KeyObject } from "node:crypto";

import { CanonicalSerializer } from "@parmana/crypto";
import type { NonceStore } from "@parmana/envelope-verifier";

/**
 * parmana-core's external connector protocol (docs/adr/ADR-0013-Generic-External-Connector.md).
 *
 * parmana-core POSTs { release, signature } to the registered endpoint. The
 * signature is the authentication: there is no bearer token on this path. The
 * release is refused unless it verifies against Parmana's public key, names
 * this endpoint as its audience, has not expired, and has not run before.
 *
 * The check order and error meaning match typescript/src/crypto/release.ts in
 * parmana-core, which is the reference implementation.
 */

/** Key id parmana-core signs releases with. Its public key is the one this service trusts. */
export const RELEASE_KEY_ID = "default";

/** How far the clock may be behind before an expired release is refused, in milliseconds. */
const CLOCK_SKEW_MS = 30_000;

export interface ExternalRelease {
  readonly version: 1;
  readonly connectorId: string;
  readonly audience: string;
  readonly businessTransactionId: string;
  readonly authorizationId: string;
  readonly capability: string;
  readonly target: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly policy: Readonly<Record<string, unknown>>;
  readonly approvedBy: readonly unknown[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly conditions?: readonly unknown[];
}

export interface SignedExternalRelease {
  readonly release: ExternalRelease;
  readonly signature: {
    readonly algorithm: string;
    readonly keyId: string;
    readonly value: string;
  };
}

export type ExternalReleaseCheck =
  | { readonly valid: true; readonly release: ExternalRelease }
  | { readonly valid: false; readonly errors: readonly string[] };

export interface ExternalReleaseOptions {
  readonly publicKey: KeyObject;
  /** This endpoint's URL, exactly as it is registered in parmana-core. */
  readonly audience: string;
  readonly now: Date;
  readonly nonceStore: NonceStore;
}

/** True when the body has the shape of a signed release. Says nothing about its validity. */
export function isSignedExternalRelease(
  body: unknown,
): body is SignedExternalRelease {
  return isObject(body) && isObject(body.release) && isObject(body.signature);
}

/**
 * Verifies a signed release. Returns the release only when every check passes.
 * The replay record is written last, so a release that fails any other check
 * does not use up its businessTransactionId.
 */
export async function verifyExternalRelease(
  body: SignedExternalRelease,
  options: ExternalReleaseOptions,
): Promise<ExternalReleaseCheck> {
  const { release, signature } = body;
  const errors = shapeErrors(release);

  if (signature.algorithm !== "ed25519") {
    errors.push("signature.algorithm must be ed25519");
  }
  if (signature.keyId !== RELEASE_KEY_ID) {
    errors.push(`signature.keyId must be ${RELEASE_KEY_ID}`);
  }
  if (typeof signature.value !== "string") {
    errors.push("signature.value must be a string");
  } else if (!signatureVerifies(options.publicKey, signature.value, release)) {
    errors.push("the signature does not verify");
  }

  if (release.audience !== options.audience) {
    errors.push(
      `release.audience ${JSON.stringify(release.audience ?? null)} is not this endpoint (${options.audience})`,
    );
  }

  const expiresAt =
    typeof release.expiresAt === "string"
      ? Date.parse(release.expiresAt)
      : Number.NaN;
  if (Number.isNaN(expiresAt)) {
    errors.push("release.expiresAt is not a date");
  } else if (options.now.getTime() > expiresAt + CLOCK_SKEW_MS) {
    errors.push(`the release expired at ${release.expiresAt}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const fresh = await options.nonceStore.checkAndRecord(
    `release:${release.businessTransactionId}`,
    release.expiresAt,
  );
  if (!fresh) {
    return {
      valid: false,
      errors: ["this businessTransactionId was already executed"],
    };
  }

  return { valid: true, release };
}

function signatureVerifies(
  publicKey: KeyObject,
  value: string,
  release: ExternalRelease,
): boolean {
  try {
    const bytes = new CanonicalSerializer().serialize(release);
    return verify(null, bytes, publicKey, Buffer.from(value, "base64"));
  } catch {
    return false;
  }
}

function shapeErrors(release: ExternalRelease): string[] {
  const errors: string[] = [];

  if (release.version !== 1) errors.push("release.version must be 1");
  for (const field of [
    "businessTransactionId",
    "capability",
    "target",
    "audience",
    "expiresAt",
  ] as const) {
    if (typeof release[field] !== "string" || release[field].length === 0) {
      errors.push(`release.${field} must be a non-empty string`);
    }
  }
  if (!isObject(release.parameters)) {
    errors.push("release.parameters must be an object");
  }

  return errors;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
