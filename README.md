# parmana-connect

Connectors and agent integration for [Parmana](https://docs.parmanasystems.com), the authorization layer for AI execution. Every action an agent takes goes through Parmana's policy check, and Parmana keeps a signed record of it.

This repository provides three things:

1. **A connector manifest**: a YAML or JSON description of a REST system's capabilities. No connector code is needed.
2. **An execution service**: the receiving side of a Parmana approval. It checks the approval, then runs the connector.
3. **An MCP server**: exposes each capability as a tool for an agent. Every call goes to Parmana first.

## Quick start

Requires Node.js 24 or later.

```bash
npm ci
npm run build
npm test
```

Tests need a PostgreSQL database for the replay-protection tests. Set `PARMANA_TEST_DATABASE_URL` to run them. Without it they are skipped.

## Documentation

- **[End-to-end guide](docs/END-TO-END.md)**: how the pieces fit together, from a manifest to a signed record, with a walkthrough against the public sandbox.
- **[Execution service](docs/EXECUTION-SERVICE.md)**: what the service checks, its configuration, and its known gaps.
- **[MCP server](docs/MCP-SERVER.md)**: the tools, the configuration, and each outcome an agent can see.
- **[Objective and design](docs/OBJECTIVE.md)**: the goal, the open decisions, and the build order.

## Layout

| Path                                               | Contents                                                        |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `schema/manifest.schema.json`                      | JSON Schema for manifests                                       |
| `src/manifest.ts`                                  | Loads and validates manifests                                   |
| `src/connector.ts`                                 | The generic connector: runs a manifest's capabilities over HTTP |
| `src/execution-service.ts`                         | The receiving side: checks an approval, then runs the connector |
| `src/postgres-nonce-store.ts`                      | Shared single-use nonce store, backed by PostgreSQL             |
| `src/mcp-tools.ts`, `src/mcp-server.ts`            | MCP tools, built from the manifest's capabilities               |
| `src/parmana-client.ts`                            | HTTP client for Parmana's API                                   |
| `src/config.ts`, `src/mcp-config.ts`               | Environment-based configuration, refusing invalid values        |
| `src/main.ts`, `src/mcp-main.ts`, `src/migrate.ts` | Entry points                                                    |

## Status

Development. The execution service and the MCP server are built and tested, but neither has been run against a production Parmana deployment. The public sandbox has been used for a live check, and the approved path there is currently blocked by a missing table on the sandbox side. See the end-to-end guide for details.
