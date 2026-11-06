import { createHash, verify, type KeyObject } from "node:crypto";

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

/**
 * Above this many bytes, parmana-core signs a release as a SHA-512 commitment
 * of its canonical bytes, not the raw bytes (packages/crypto/src/SignatureCommitment.ts,
 * ADR-0010). The limit and the prefix must match parmana-core exactly.
 */
const KMS_RAW_MESSAGE_LIMIT_BYTES = 4096;
const COMMITMENT_PREFIX = Buffer.from("PARMANA-ED25519-LARGE-MESSAGE-V1\0", "utf8");

/** How far the clock may be behind before an expired release is refused, in milliseconds. */
const CLOCK_SKEW_MS = 30_000;

/**
 * Longest lifetime a release may have, from issuedAt to expiresAt. parmana-core
 * issues releases with a 60 s TTL (EXTERNAL_RELEASE_TTL_MS in
 * execution-gateway) and only shortens them, so a longer one was not issued by it.
 */
const MAX_RELEASE_LIFETIME_MS = 60_000;

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
  /** The capabilities this endpoint serves. A release for any other is refused. */
  readonly capabilities: readonly string[];
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
 * Checks a signed release without recording it as executed. Every check except
 * replay: shape, signature, capability, audience and expiry. The caller decides
 * what to do with a release that passes, for example whether it has already
 * been answered. Use this before reading any stored answer, so that only a
 * genuine release can receive one.
 */
export async function checkExternalRelease(
  body: SignedExternalRelease,
  options: Omit<ExternalReleaseOptions, "nonceStore">,
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

  if (!options.capabilities.includes(release.capability)) {
    errors.push(
      `release.capability ${JSON.stringify(release.capability ?? null)} is not served by this endpoint`,
    );
  }

  if (release.audience !== options.audience) {
    errors.push(
      `release.audience ${JSON.stringify(release.audience ?? null)} is not this endpoint (${options.audience})`,
    );
  }

  const issuedAt =
    typeof release.issuedAt === "string"
      ? Date.parse(release.issuedAt)
      : Number.NaN;
  const expiresAt =
    typeof release.expiresAt === "string"
      ? Date.parse(release.expiresAt)
      : Number.NaN;
  if (Number.isNaN(issuedAt)) {
    errors.push("release.issuedAt is not a date");
  } else if (issuedAt > options.now.getTime() + CLOCK_SKEW_MS) {
    errors.push(`the release was issued in the future, at ${release.issuedAt}`);
  }
  if (Number.isNaN(expiresAt)) {
    errors.push("release.expiresAt is not a date");
  } else if (options.now.getTime() > expiresAt + CLOCK_SKEW_MS) {
    errors.push(`the release expired at ${release.expiresAt}`);
  }
  if (!Number.isNaN(issuedAt) && !Number.isNaN(expiresAt)) {
    const lifetime = expiresAt - issuedAt;
    if (lifetime <= 0) {
      errors.push("release.expiresAt must be after release.issuedAt");
    } else if (lifetime > MAX_RELEASE_LIFETIME_MS) {
      errors.push(
        `the release lifetime is ${lifetime / 1000} s; the limit is ${MAX_RELEASE_LIFETIME_MS / 1000} s`,
      );
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, release };
}

/**
 * Verifies a signed release and records its businessTransactionId as used.
 * Returns the release only when every check passes, and the replay record is
 * written last, so a release that fails another check does not use up its id.
 */
export async function verifyExternalRelease(
  body: SignedExternalRelease,
  options: ExternalReleaseOptions,
): Promise<ExternalReleaseCheck> {
  const check = await checkExternalRelease(body, options);
  if (!check.valid) return check;

  const fresh = await options.nonceStore.checkAndRecord(
    `release:${check.release.businessTransactionId}`,
    check.release.expiresAt,
  );
  if (!fresh) {
    return {
      valid: false,
      errors: ["this businessTransactionId was already executed"],
    };
  }

  return check;
}

function signatureVerifies(
  publicKey: KeyObject,
  value: string,
  release: ExternalRelease,
): boolean {
  try {
    const bytes = new CanonicalSerializer().serialize(release);
    const signature = Buffer.from(value, "base64");
    if (verify(null, bytes, publicKey, signature)) return true;
    // A commitment is accepted only above the limit, so it cannot stand in
    // for a signature over a small message. parmana-core does the same.
    if (bytes.length <= KMS_RAW_MESSAGE_LIMIT_BYTES) return false;
    const commitment = Buffer.concat([COMMITMENT_PREFIX, createHash("sha512").update(bytes).digest()]);
    return verify(null, commitment, publicKey, signature);
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
