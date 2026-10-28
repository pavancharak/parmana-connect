# MCP server

The MCP server lets an agent call a connector's capabilities as tools. Every call goes to Parmana's `POST /execute`, and Parmana decides whether it may run. The server never calls the upstream system directly.

Start it on stdio with `npm run mcp` after `npm run build`. An agent launches it, so it reads its settings from the environment.

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

## Tools

Each capability in the manifest is one tool, named by its id, for example `hubspot:deal-update`. The tool takes:

- `target`: what the action applies to, for example `crm/deals/123`. Required.
- The capability's own inputs, with their declared types. Anything else is refused before a request is sent.

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

- **Signals are sent empty.** A policy that needs facts in `signals` will refuse the call. Supplying them needs a design decision.
- **Input is checked by Parmana and the connector, not by the MCP layer alone** beyond the names and required fields.
- **No live test against Parmana yet.** The tests use a stub of its API. Test against a sandbox with a real key before use.
