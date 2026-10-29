// Sends one signed, approved request to the execution service, the way
// parmana-core does: the authorization is signed with the private key, and
// the body is posted with the bearer token.
//
// Usage (from the parmana-connect folder):
//   node --env-file=.env scripts/signed-request.mjs <path to default.private.pem>
//
// Reads PARMANA_SERVICE_BEARER_TOKEN and PARMANA_POLICY_DIR from the
// environment, and sends to PARMANA_SERVICE_URL (default http://localhost:8080).

import { readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";

import { AuthorizationSigner, CryptoBootstrap, TrustRecordHasher } from "@parmana/crypto";
import { HttpExecutionSystem } from "@parmana/execution-system";
import { toExecutableContent } from "@parmana/shared";

const keyFile = process.argv[2];
const bearer = process.env.PARMANA_SERVICE_BEARER_TOKEN;
const serviceUrl = process.env.PARMANA_SERVICE_URL ?? "http://localhost:8080";
const action = process.env.PARMANA_TEST_ACTION ?? "httpbin:get";
const target = process.env.PARMANA_TEST_TARGET ?? "httpbin";
const transactionId = `txn-local-${Date.now()}`;

if (!keyFile) throw new Error("Give the path to default.private.pem as the first argument.");
if (!bearer) throw new Error("PARMANA_SERVICE_BEARER_TOKEN is not set. Use --env-file=.env.");
if (!process.env.PARMANA_POLICY_DIR) throw new Error("PARMANA_POLICY_DIR is not set. Use --env-file=.env.");

const crypto = CryptoBootstrap.create();
const trustHasher = new TrustRecordHasher(crypto);
const privateKey = createPrivateKey(readFileSync(keyFile, "utf8"));
const parameters = {};

const executableContent = toExecutableContent({
  businessTransactionId: transactionId,
  action,
  target,
  parameters,
});

const authorization = await new AuthorizationSigner(crypto).sign(
  {
    decisionId: `decision-${transactionId}`,
    decisionOutcome: "APPROVED",
    businessTransactionId: transactionId,
    policyName: "local-test",
    policyVersion: "1.0.0",
    policyContentHash: await trustHasher.hash({ policy: "local-test" }),
    signalsHash: await trustHasher.hash({ signals: {} }),
    executableContent,
    grantedCapability: action,
  },
  privateKey,
  "default",
  60,
);

const executionSystem = new HttpExecutionSystem({
  baseUrl: serviceUrl,
  headers: { Authorization: `Bearer ${bearer}` },
  timeout: 15_000,
});

try {
  const result = await executionSystem.execute({
    businessTransactionId: transactionId,
    action,
    target,
    parameters,
    authorization,
  });
  console.log("Result:", JSON.stringify(result, null, 2));
} catch (err) {
  console.error("Refused or failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
