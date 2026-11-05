import { readFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MemoryNonceStore } from "@parmana/envelope-verifier";

import { verifyExternalRelease, type SignedExternalRelease } from "../src/external-release.js";

// Fixtures generated with parmana-core's own code: CanonicalSerializer and
// SignatureCommitment from packages/crypto/src, signed with an Ed25519 key.
// The small release is signed raw. The large one (over 4096 bytes) is signed
// as a SHA-512 commitment, as parmana-core's KmsSigner does (ADR-0010).
// Regenerate them from parmana-core, not by hand, when the format changes.

const DIR = join(__dirname, "fixtures", "parmana-core");
const AUDIENCE = "https://parmana-connect.example.com/execute";
const NOW = new Date("2026-10-29T06:00:00.000Z");
const publicKey = createPublicKey(readFileSync(join(DIR, "core-public-key.txt"), "utf8"));

function load(name: string): SignedExternalRelease {
  return JSON.parse(readFileSync(join(DIR, name), "utf8")) as SignedExternalRelease;
}

function options() {
  return {
    publicKey,
    audience: AUDIENCE,
    capabilities: ["example:item-fetch"],
    now: NOW,
    nonceStore: new MemoryNonceStore(),
  };
}

describe("releases signed by parmana-core", () => {
  it("verifies a small release signed raw", async () => {
    const result = await verifyExternalRelease(load("core-release-small.json"), options());
    expect(result.valid).toBe(true);
  });

  it("verifies a large release signed as a commitment, the form KmsSigner produces above 4096 bytes", async () => {
    const result = await verifyExternalRelease(load("core-release-large.json"), options());
    expect(result).toMatchObject({ valid: true });
  });

  it("refuses a large release whose commitment signature is altered", async () => {
    const tampered = load("core-release-large.json");
    const changed = {
      ...tampered,
      release: { ...tampered.release, parameters: { ...(tampered.release.parameters as object), note: "changed" } },
    };
    const result = await verifyExternalRelease(changed as SignedExternalRelease, options());
    expect(result.valid).toBe(false);
  });

  it("refuses a small release presented as a commitment, so a commitment cannot downgrade a small message", async () => {
    // A key the test controls, so the signature is real and only the form is wrong.
    const { createHash, generateKeyPairSync, sign } = await import("node:crypto");
    const { CanonicalSerializer } = await import("@parmana/crypto");
    const keys = generateKeyPairSync("ed25519");
    const small = load("core-release-small.json").release;
    const bytes = new CanonicalSerializer().serialize(small);
    const commitment = Buffer.concat([
      Buffer.from("PARMANA-ED25519-LARGE-MESSAGE-V1\0", "utf8"),
      createHash("sha512").update(bytes).digest(),
    ]);
    const value = sign(null, commitment, keys.privateKey).toString("base64");
    const body = { release: small, signature: { algorithm: "ed25519", keyId: "default", value } };

    const result = await verifyExternalRelease(body, { ...options(), publicKey: keys.publicKey });
    expect(result.valid).toBe(false);
  });
});
