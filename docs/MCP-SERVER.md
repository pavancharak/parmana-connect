# MCP server

The MCP server lets an agent call a connector's capabilities as tools. Every call goes to Parmana's `POST /execute`, and Parmana decides whether it may run. The server never calls the upstream system directly.

Start it on stdio with `npm run mcp` after `npm run build`. An agent launches it, so it reads its settings from the environment.

To reach it over the network, for a remote agent such as a Managed Agents session, start the HTTP entry point with `npm run mcp:http`. See [Over HTTP](#over-http).

## Configuration

| Variable                        | Required | Meaning                                                                     |
| ------------------------------- | -------- | --------------------------------------------------------------------------- |
| `PARMANA_API_URL`               | yes      | Parmana's base URL. Must be `https://`.                                     |
| `PARMANA_API_KEY`               | yes      | The caller's key, sent as a bearer token. It is never returned in a result. |
| `PARMANA_AUTHORITY_ID`          | yes      | The authority this deployment acts under.                                   |
| `PARMANA_AUTHORITY_TYPE`        | yes      | `USER`, `ROLE`, `SERVICE` or `ORGANIZATION`.                                |
| `PARMANA_PRINCIPAL_ID`          | yes      | The principal the actions are for.                                          |
| `PARMANA_AUTHORIZATION_ID`      | yes      | The authorization the actions are made under.                               |
| `PARMANA_AUTHORIZATION_PURPOSE` | yes      | Why the actions are made, as Parmana records it.                            |
| `PARMANA_CONNECTOR_MANIFEST`    | yes      | Path to the connector manifest. Its capabilities become the tools.          |
| `PARMANA_SOURCE_SYSTEM`         | no       | Defaults to `parmana-connect`.                                              |
| `PARMANA_SUBMITTED_BY`          | no       | Defaults to the principal.                                                  |

The authority and authorization are set once, in configuration. An agent cannot choose them.

## Over HTTP

`npm run mcp:http` serves the same tools over streamable HTTP at `POST /mcp`. It takes every setting in the table above, plus:

| Variable                   | Required | Meaning                                                                                  |
| -------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `PARMANA_MCP_BEARER_TOKEN` | yes      | The token an MCP client must send as `Authorization: Bearer <token>`. At least 32 characters. |
| `PARMANA_MCP_HOST`         | no       | Address to bind. Defaults to `127.0.0.1`.                                                |
| `PARMANA_MCP_PORT`         | no       | Port to bind. Defaults to `8081`.                                                        |

The endpoint speaks plain HTTP, so it must sit behind an HTTPS terminator, and the bearer token must travel only over HTTPS. Set `PARMANA_MCP_HOST` to `0.0.0.0` only behind that terminator.

- Every request needs the bearer token. The token is compared in constant time. A missing or wrong token gets `401` with `WWW-Authenticate`.
- Only `POST /mcp` is served. Any other path gets `404`, and any other method gets `405`.
- The body must be JSON, at most 1 MB.
- The server keeps no session state. Each request gets its own MCP server, closed when the response ends.
- The tool outcomes are the ones in the table below. Nothing about the call changes because it came over HTTP.

For a Managed Agents session, store the token in a vault as a `static_bearer` credential keyed by the endpoint URL. The vault injects it when the agent connects. Attach the vault to the session with `vault_ids`. The token never has to appear in the agent's configuration or prompts.

## Tools

Each capability in the manifest is one tool, named by its id, for example `example:item-update`. The tool takes:

- `target`: what the action applies to, for example `items/123`. Required.
- The capability's own inputs, with their declared types. Anything else is refused before a request is sent.
- `signals` (optional): facts and signed approvals the policy requires, sent to Parmana unchanged. It must be an object. The approval comes from the person who approves the action; the server never creates one.

## What each call does

1. Reads `GET /policies/in-effect` for the capability, so the policy and version are the ones in effect now.
2. Sends one `POST /execute` with a new business transaction id. That id is the idempotency key.
3. Returns the outcome in words the agent can act on.

## Outcomes

| Parmana response                      | Result to the agent                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `200`                                 | The signed trust record, as text.                                                                                                      |
| `403` `POLICY_DENIED`                 | Refused by policy. Nothing was released.                                                                                               |
| `403` other                           | This key may not invoke this action. Nothing was released.                                                                             |
| `409` `AUTHORIZATION_NO_LONGER_VALID` | Nothing was sent. The agent may send a new request.                                                                                    |
| `503`                                 | Refused before release. Nothing was executed.                                                                                          |
| `502` `EXECUTION_OUTCOME_UNKNOWN`     | Released, but the outcome is unknown. Do not send again under a new id. Check the target system, then an operator resolves the intent. |
| `500` `EXECUTION_RECORD_INCOMPLETE`   | Released, but the record could not be produced. Do not resend. An operator must finalize it.                                           |
| anything else                         | The HTTP status, and that nothing was retried.                                                                                         |

If Parmana cannot be reached, the result says that the call did not complete and that nothing was retried. The server never retries a call, so a timed-out action is never sent twice by this server.

## Known gaps

- **Signals are the caller's responsibility.** The server passes them through unchecked, so a policy that needs a signal the caller does not supply will refuse the call.
- **Input is checked by Parmana and the connector, not by the MCP layer alone** beyond the names and required fields.
- **No live test against Parmana yet.** The tests use a stub of its API. Test against a sandbox with a real key before use.

## Sandbox check

The public sandbox has one action, `sandbox:receipt`, and a demo key. To try the approved path:

1. `POST /sandbox/approvals` with `{ "capability": "sandbox:receipt", "resourceId": "<target>" }` returns a demo approval, valid for five minutes and accepted once.
2. Call the tool with `target` set to the same resource, `note`, and `signals: { note, receiptApproved: true, approvalArtifact: <the approval> }`.

Without an approval, the sandbox refuses the call with `POLICY_DENIED`, which is what the server reports. On 2026-10-28 a release with an approval reached the sandbox, but the sandbox failed to record the outcome, because its `execution_outcomes` table does not exist there. The server correctly reported the outcome as unknown and said not to resend. The intent shows `ERRORED`, so the sandbox needs that table created.
