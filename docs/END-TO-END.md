# End-to-end guide

This guide follows one action from an agent's request to a signed record. It covers the manifest, the execution service, the MCP server, and a walkthrough against Parmana's public sandbox. Each part also has its own reference document: [execution service](EXECUTION-SERVICE.md) and [MCP server](MCP-SERVER.md).

## 1. How the pieces fit

```
agent
  │  calls a tool, e.g. hubspot:deal-update
  ▼
MCP server (this repo, npm run mcp)
  │  1. GET  /policies/in-effect?capability=…       read the policy and version now in effect
  │  2. POST /execute                               one transaction, with the authority, intent and signals
  ▼
Parmana (parmana-core)
  │  evaluates the policy, checks any signed approval, records the decision
  │  releases the action to its execution system
  ▼
execution service (this repo, npm start)
  │  verifies the signed authorization: signature, expiry, TTL, single-use nonce
  │  recomputes the transaction hash and checks it matches the approval
  │  checks the approval covers this action
  ▼
generic connector (this repo)
  │  checks the input against the manifest, then calls the upstream API
  ▼
upstream system (for example HubSpot)
```

The result travels back along the same path. Parmana writes a signed Execution Trust Record for each release, and the agent receives its summary.

Two rules hold throughout:

- **The agent never holds the upstream credential.** It is read from the service's environment, and it is sent only to the upstream system.
- **A call that might have run is never retried by this code.** If the outcome is unknown, the agent is told not to resend under a new id.

## 2. Write a manifest

A manifest describes one system: its base URL, how to authenticate, and its capabilities. The schema is `schema/manifest.schema.json`.

```yaml
system: hubspot
baseUrl: https://api.hubapi.com
apiVersion: v3
credential:
  type: bearer
  secretRef: HUBSPOT_TOKEN
capabilities:
  - id: hubspot:deal-fetch
    method: GET
    path: /crm/v3/objects/deals/{dealId}
    effect: read
    input:
      dealId: { type: string, required: true }
  - id: hubspot:deal-update
    method: PATCH
    path: /crm/v3/objects/deals/{dealId}
    effect: write
    input:
      dealId: { type: string, required: true }
      properties: { type: object, required: true }
```

The rules, enforced when the manifest is loaded:

- Capability ids start with the system name, for example `hubspot:…`, and no id repeats.
- `GET` capabilities are `read`. A `write` capability declares its inputs.
- Every `{name}` in a path is a required input.
- The base URL is `https://`, with no credentials, query or fragment.
- The credential is a reference to an environment variable (`secretRef`), never a literal value.
- YAML aliases and duplicate keys are refused.

Each capability's inputs are sent as follows. Path inputs are placed in the URL, URL-encoded. For `POST`, `PUT` and `PATCH`, the remaining inputs form a JSON body. For `GET` and `DELETE`, they go in the query string.

Check a manifest with `loadManifest` from `src/manifest.ts`. The service and the MCP server both refuse an invalid one at startup.

## 3. Start the execution service

The service receives approved requests from Parmana. Its settings come from the environment, and it refuses to start if a required one is missing or invalid. The full table is in [EXECUTION-SERVICE.md](EXECUTION-SERVICE.md#running-it). The required settings are:

| Variable                                     | Meaning                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PARMANA_SERVICE_BEARER_TOKEN`               | Shared secret that Parmana sends. At least 32 characters.                             |
| `PARMANA_PUBLIC_KEY_FILE`                    | Path to Parmana's Ed25519 public key, in PEM.                                         |
| `PARMANA_CONNECTOR_MANIFEST`                 | Path to the manifest from step 2.                                                     |
| `HUBSPOT_TOKEN` (or the name in `secretRef`) | The upstream secret.                                                                  |
| `PARMANA_POLICY_DIR`                         | Any existing directory. The crypto bootstrap requires it.                             |
| `PARMANA_DATABASE_URL`                       | PostgreSQL, for the shared nonce store. Required unless `PARMANA_NONCE_STORE=memory`. |

Then run:

```bash
npm run build
npm run migrate      # creates the nonce table; safe to repeat
npm start            # listens on PARMANA_SERVICE_PORT, default 8080
```

If a setting is missing, the process exits with a message that names the variable. It never prints a value.

**Connecting Parmana to the service.** Configure parmana-core's execution system as an HTTP execution system whose base URL is the service's address. Its requests carry the bearer token in an `Authorization` header. The service accepts `POST /execute` only. It has no health route yet.

**Running more than one instance.** Each instance must point at the same `PARMANA_DATABASE_URL`. With `PARMANA_NONCE_STORE=memory`, replay protection is per process, and that setting is for local development only.

## 4. Start the MCP server

The MCP server exposes the manifest's capabilities as tools. It runs on stdio, and an agent starts it. Its settings are:

| Variable                        | Required | Meaning                                                   |
| ------------------------------- | -------- | --------------------------------------------------------- |
| `PARMANA_API_URL`               | yes      | Parmana's base URL. Must be `https://`.                   |
| `PARMANA_API_KEY`               | yes      | The caller's key. Sent as a bearer token; never returned. |
| `PARMANA_AUTHORITY_ID`          | yes      | The authority this deployment acts under.                 |
| `PARMANA_AUTHORITY_TYPE`        | yes      | `USER`, `ROLE`, `SERVICE` or `ORGANIZATION`.              |
| `PARMANA_PRINCIPAL_ID`          | yes      | The principal the actions are for.                        |
| `PARMANA_AUTHORIZATION_ID`      | yes      | The authorization the actions are made under.             |
| `PARMANA_AUTHORIZATION_PURPOSE` | yes      | Why the actions are made, as Parmana records it.          |
| `PARMANA_CONNECTOR_MANIFEST`    | yes      | The manifest; its capabilities become tools.              |
| `PARMANA_SOURCE_SYSTEM`         | no       | Defaults to `parmana-connect`.                            |
| `PARMANA_SUBMITTED_BY`          | no       | Defaults to the principal.                                |

Agents launch it with a configuration like this (the values are yours to fill in, and they belong in the agent's secret store, not in a file in this repository):

```json
{
  "mcpServers": {
    "parmana-hubspot": {
      "command": "node",
      "args": ["/path/to/parmana-connect/dist/mcp-main.js"],
      "env": {
        "PARMANA_API_URL": "https://…",
        "PARMANA_API_KEY": "…",
        "PARMANA_AUTHORITY_ID": "…",
        "PARMANA_AUTHORITY_TYPE": "SERVICE",
        "PARMANA_PRINCIPAL_ID": "…",
        "PARMANA_AUTHORIZATION_ID": "…",
        "PARMANA_AUTHORIZATION_PURPOSE": "…",
        "PARMANA_CONNECTOR_MANIFEST": "/path/to/manifest.yaml"
      }
    }
  }
}
```

Each tool takes `target`, the capability's own inputs, and an optional `signals` object. The `signals` are the facts and signed approvals the policy requires, and a person supplies them. The server passes them through unchanged. See [MCP-SERVER.md](MCP-SERVER.md#tools) for the details.

## 5. One call, step by step

For `hubspot:deal-update` on deal 123, approved by a person:

1. The agent calls the tool with `target: "crm/deals/123"`, `dealId: "123"`, `properties: {dealstage: "won"}`, and `signals` holding the person's approval.
2. The server validates the arguments against the manifest. An unknown or missing argument is refused here, and nothing is sent.
3. The server reads the policy in effect for `hubspot:deal-update`.
4. The server sends one `POST /execute`, with a new business transaction id, the authority, the authorization, the intent and the policy. The id is the idempotency key.
5. Parmana evaluates the policy and checks the approval. If it refuses, the agent gets `Refused by policy. Nothing was released.` and the flow stops.
6. If it approves, Parmana releases the action to the execution service.
7. The service checks the signed authorization, recomputes the transaction hash, and confirms the approval covers this action. Any failure returns 403 and nothing runs.
8. The generic connector checks the input against the manifest and calls HubSpot with the upstream credential.
9. The service returns the result. Parmana signs a trust record and returns it.
10. The agent gets the trust record as text.

If step 8 or 9 fails after the action may have run, the agent gets an unknown-outcome message and is told not to resend. The operator resolves the intent in Parmana.

## 6. Outcomes an agent can see

| Parmana response                      | Message to the agent                                                    | Retry?                       |
| ------------------------------------- | ----------------------------------------------------------------------- | ---------------------------- |
| `200`                                 | The signed trust record                                                 | —                            |
| `403` `POLICY_DENIED`                 | Refused by policy. Nothing was released.                                | No                           |
| `403` other                           | This key may not invoke this action. Nothing was released.              | No                           |
| `409` `AUTHORIZATION_NO_LONGER_VALID` | Nothing was sent.                                                       | Yes, with a new request      |
| `503`                                 | Refused before release. Nothing was executed.                           | Not by this server           |
| `502` `EXECUTION_OUTCOME_UNKNOWN`     | Released, but the outcome is unknown. Do not send again under a new id. | No: check the target system  |
| `500` `EXECUTION_RECORD_INCOMPLETE`   | Released, but the record could not be produced. Do not resend.          | No: an operator finalizes it |
| anything else                         | The HTTP status. Nothing was retried.                                   | No                           |

The server never retries a call.

## 7. Walkthrough against the public sandbox

Parmana publishes a sandbox at `https://parmana-sandbox.vercel.app`, with a demo key shown in its playground. It has one action, `sandbox:receipt`, and its demo data is public. Do not send personal data to it.

Write a manifest for the sandbox action:

```yaml
system: sandbox
baseUrl: https://example.com
apiVersion: "1"
credential: { type: bearer, secretRef: SANDBOX_UNUSED }
capabilities:
  - id: sandbox:receipt
    method: POST
    path: /receipt
    effect: write
    input:
      note: { type: string, required: true }
```

The sandbox then behaves as follows:

1. **Without an approval**, the call is refused: `Refused by policy. Nothing was released.` This is the expected result.
2. **With an approval**, the server first asks the sandbox for one with `POST /sandbox/approvals`, for the same target. The approval is valid for five minutes and accepted once. The call then carries `signals: { note, receiptApproved: true, approvalArtifact: <the approval> }`.

On 2026-10-28 step 2 reached the release, but the sandbox could not record the outcome. Its intent shows `ERRORED` with `relation "execution_outcomes" does not exist`, so a table is missing on the sandbox. The server reported the outcome as unknown and said not to resend. Until the sandbox is fixed, this path cannot be completed.

## 8. Before using this in production

- Run `npm run migrate` against the production database, and check the table exists.
- Use `PARMANA_NONCE_STORE=postgres`, the default, and confirm every instance points at the same database.
- Get Parmana's public key from the deployment, and check its fingerprint through a channel other than the one that delivered it.
- Set the bearer token and the upstream credential in a secret store. Do not put them in files in this repository.
- Set the connector's base URL to the real upstream system, and check it is `https://`.
- Test each capability against a sandbox or a test account of the upstream system, with a real Parmana deployment.
- Confirm the branch protection requires the CI and DCO checks on `main`.

## 9. Known gaps

- **Signals** are passed through without checks. A policy that needs a signal the caller does not supply refuses the call.
- **The execution service has no health route** and no configuration for its own TLS. Put it behind a TLS-terminating proxy.
- **Replay protection** depends on the nonce store. With `memory`, it does not hold across processes.
- **The MCP server has not run against a production deployment.** Its live check used the sandbox, and the approved path is blocked on the sandbox side.
- **The Python connector SDK and a Python receiving service** are not part of this repository. See [EXECUTION-SERVICE.md](EXECUTION-SERVICE.md#why-there-is-no-python-version).

## 10. Troubleshooting

| Symptom                                         | Cause and fix                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| The service exits at startup, naming a variable | That variable is missing or invalid. Set it; the message does not show values.                              |
| `PARMANA_DATABASE_URL is required`              | The default store is Postgres. Set the URL, or set `PARMANA_NONCE_STORE=memory` for local development only. |
| `policy lookup returned HTTP 4xx`               | The key may not invoke this capability, or the URL is wrong.                                                |
| `Refused by policy` on every call               | The policy needs a signal the call does not supply. Pass it in `signals`.                                   |
| Tests run against a stale copy of a dependency  | Delete `node_modules` and run `npm ci` again.                                                               |
| CI reports nothing on a pull request            | Check the workflow file is valid. A workflow that fails to parse runs no jobs at all.                       |
