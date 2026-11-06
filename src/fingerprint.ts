import { createHash, type KeyObject } from "node:crypto";

/** SHA-256 of the SPKI DER encoding, in the form the verifier pins: `sha256:<64 hex>`. */
export function fingerprintOf(key: KeyObject): string {
  const der = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}
