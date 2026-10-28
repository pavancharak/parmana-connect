# parmana-connect: objective, contents and how it works

## Objective

Make it quick and low-effort for a team to connect an AI agent, or an existing system, to Parmana, so that every action the agent takes goes through Parmana's policy check and produces a signed record.

Today, adding a connector means editing `parmana-core` source and sending a pull request. That blocks adoption by people outside the core team. This repo removes that step for the common cases.

### Success looks like

- A developer can describe a new REST capability in a manifest file and use it through Parmana without writing connector code.
- An agent framework that supports MCP can call Parmana's actions as tools with no custom SDK code.
- Each connector declares what it can do, what data it accepts, and which credential it needs, so reviewers can see the scope before it runs.
- A connector that passes the checks here can be used against a running `parmana-core` instance without changes to that instance.

### Non-goals

- This repo does not replace `parmana-core`. Policy evaluation, signing, the execution gateway and the trust record stay there.
- It does not decide what an agent should do. That is the job of the policy.
- It does not hold long-lived credentials in the agent's process. Credentials are resolved by the gateway side, as in `parmana-core`.

## Contents

| Path                 | Purpose                                                                     |
| -------------------- | --------------------------------------------------------------------------- |
| `docs/OBJECTIVE.md`  | This file: goal, contents and design                                        |
| `manifests/`         | Connector manifests (YAML or JSON), one per system, validated against schema |
| `schema/`            | JSON Schema for the manifest format                                         |
| `packages/generic/`  | Generic HTTP connector that runs any valid manifest                         |
| `packages/mcp/`      | MCP server that exposes Parmana actions as agent tools                      |
| `packages/cli/`      | Command line tool: validate a manifest, run it against a local Parmana      |
| `examples/`          | Working examples, starting with one read and one write against a sandbox    |
| `tests/`             | Tests for the manifest validator, the generic connector and the MCP server  |

## How it works

### 1. Manifest

A manifest describes one system and the capabilities it exposes. Example shape (illustrative, not final):

```yaml
system: hubspot
baseUrl: https://api.hubapi.com
credential:
  type: bearer
  secretRef: HUBSPOT_PRIVATE_APP_TOKEN
capabilities:
  - id: hubspot:deal-fetch
    method: GET
    path: /crm/v3/objects/deals/{dealId}
    input:
      dealId: { type: string, required: true }
    effect: read
  - id: hubspot:deal-update
    method: PATCH
    path: /crm/v3/objects/deals/{dealId}
    input:
      dealId: { type: string, required: true }
      properties: { type: object, required: true }
    effect: write
```

Each capability has:

- an `id` that matches the capability name Parmana's policy uses,
- an `effect` (`read` or `write`) that policy and reviewers can key on,
- a typed input, so a bad request is refused before any network call,
- a credential reference, resolved from a secret store, never written into the manifest.

### 2. Validation

Before a manifest is used, the validator checks it against the JSON Schema and rejects:

- unknown fields (so a typo cannot silently drop a restriction),
- a capability id that does not follow the naming pattern,
- a `write` capability with no declared input schema,
- a `baseUrl` that is not `https://` (unless a test flag is set),
- a credential given as a literal value instead of a reference.

### 3. Generic connector

The generic connector implements the connector contract that `parmana-core` already defines (capability definitions, schemas, and the connector and credential-provider interfaces). It:

1. takes a validated manifest and an incoming request for one capability,
2. checks the input against that capability's schema,
3. uses the credential it is handed for this one call. The caller resolves it from the secret store, as `parmana-core` does, so the connector never looks up secrets itself,
4. sends the HTTP request and returns the result in the shape the gateway expects.

It does not decide whether the call is allowed. The call only reaches it after Parmana's policy has approved it.

### 4. MCP server

The MCP server lists each capability from the loaded manifests as a tool. When an agent calls a tool, the server forwards the request to Parmana's `/execute` endpoint with the caller's API key and returns the decision and the result. If Parmana refuses the action, the tool returns the refusal and its reason, so the agent can see it.

The MCP server holds no credentials for the target system. It holds only the Parmana API key, and only the agent's side of the request.

### 5. CLI

- `parmana-connect validate <manifest>`: checks a manifest and prints errors.
- `parmana-connect run <manifest> <capability> --input <json>`: runs one capability against a local `parmana-core` for testing.
- `parmana-connect list <manifest>`: prints the capabilities and their effects, for review.

## Trust boundaries

| Boundary                         | Rule                                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| Agent to MCP server              | Agent sends only the tool input. It never sees the target credential. |
| MCP server to Parmana            | Authenticated with a Parmana API key. Every call is policy-checked.   |
| Parmana to generic connector     | Only after an approved decision. Connector re-checks the input schema. |
| Connector to target system       | Credential resolved from the secret store for one use.               |

A manifest can narrow what is possible. It cannot widen what policy allows. A capability that is not in a manifest cannot be called, even if a policy names it.

## Open questions

These are decisions to make before the code is written:

1. **Manifest format:** YAML, JSON, or both? Recommendation: YAML for authors, JSON Schema for validation.
2. **Pagination, retries and rate limits:** in the manifest, or left to each connector? Recommendation: start without them and add them when a real system needs them.
3. **Where manifests live:** in this repo, in the user's own repo, or both? Recommendation: both are supported, with examples here.
4. **Which connector first:** HubSpot deal update is the simplest write path that already has a live integration in `parmana-core`, so it can be checked against known behaviour.
5. **Versioning:** does a manifest pin the target API version? Recommendation: yes, with a required `apiVersion` field.

## Build order

1. Manifest schema and validator, with tests for each rejection rule.
2. Generic connector that runs a read-only manifest against a local stub server.
3. Add one write capability, with an input-schema test that refuses a bad request before any network call.
4. Connect the generic connector to a local `parmana-core` run, with the policy in place.
5. MCP server exposing the same capabilities as tools.
6. CLI, then examples and a getting-started guide.
