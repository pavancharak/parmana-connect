# parmana-connect

`parmana-connect` connects an external system to [Parmana](https://docs.parmanasystems.com), the authorization layer for AI actions. Parmana decides whether an action may run, under a versioned policy, and signs a record of the decision. This repository runs the part that performs the action: a connector, served over HTTPS, that Parmana releases approved actions to.

It has three parts:

1. **A connector manifest.** A YAML or JSON file that describes an HTTP system and its capabilities, such as `httpbin:get`. A manifest needs no connector code.
2. **A connector service.** A Node.js server with one route, `POST /execute`. It accepts two kinds of request: a signed release from Parmana, and a signed authorization with a bearer token. It verifies the request, runs the manifest's call, and answers.
3. **An MCP server.** It exposes each capability as a tool for an AI agent. Every tool call goes to Parmana's API first.

## How a request flows

```
agent ──► Parmana API ──► decision + signature ──► parmana-connect ──► upstream system
           (policy,         (approval checked,       (verifies the          (the manifest's
            approval)        record signed)           signature, runs it)    HTTP call)
```

Parmana checks the policy and the approval, signs the decision, and releases the action to the registered endpoint. The service verifies the release and performs the call. The result returns to Parmana, which records it. The service never decides policy, and it never sees the agent.

For the protocol, read [connect any external system](https://docs.parmanasystems.com/guides/connect-any-external-system). For the service in detail, read [the parmana-connect service](https://docs.parmanasystems.com/connectors/parmana-connect).

## Quick start

Requires Node.js 24 or later.

```bash
npm ci
npm run build
npm test
```

`npm test` runs the suite. The replay-protection tests against PostgreSQL run only when `PARMANA_TEST_DATABASE_URL` is set. Without it they are skipped, and the rest run.

To start the connector service:

```bash
node --env-file=.env dist/main.js
```

`npm start` does not read `.env`, so use the command above when you rely on a `.env` file. The service listens on `127.0.0.1:8080` by default.

## Configuration

### The connector service

| Setting                        | Required        | Default     | Purpose                                                                                                        |
| ------------------------------ | --------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| `PARMANA_SERVICE_BEARER_TOKEN` | Yes             | none        | Shared secret for signed authorizations. At least 32 characters.                                               |
| `PARMANA_PUBLIC_KEY_FILE`      | Yes             | none        | Path to Parmana's Ed25519 public key, in PEM.                                                                  |
| `PARMANA_CONNECTOR_MANIFEST`   | Yes             | none        | Path to the manifest, JSON or YAML.                                                                            |
| The manifest's `secretRef`     | Yes             | none        | The environment variable holding the upstream credential.                                                      |
| `PARMANA_POLICY_DIR`           | Yes             | none        | An existing folder. Required by the crypto setup.                                                              |
| `PARMANA_RELEASE_AUDIENCE`     | For releases    | unset       | The endpoint URL as registered in Parmana, for example `https://service.example.com/execute`. Must be `https`. |
| `PARMANA_EXPECTED_KEY_FINGERPRINT` | No          | unset       | Pins the key. The service refuses to start unless the key in `PARMANA_PUBLIC_KEY_FILE` has this `sha256:` fingerprint. Use the value you confirmed through a second channel. |
| `PARMANA_RELEASE_ONLY`          | No       | `false`. Set `true` to accept only signed releases from parmana-core. A bearer token plus a signed authorization is then refused, so no second route reaches the connector. Requires `PARMANA_RELEASE_AUDIENCE`. |
| `PARMANA_EXPECTED_AUDIENCE`    | No              | unset       | Pins the audience. The service refuses to start unless `PARMANA_RELEASE_AUDIENCE` equals this value exactly. |
| `PARMANA_NONCE_STORE`          | No              | `postgres`  | `postgres` shares replay records across instances. `memory` is for one instance only.                          |
| `PARMANA_DATABASE_URL`         | With `postgres` | none        | Connection string for the replay store.                                                                        |
| `PARMANA_SERVICE_PORT`         | No              | `8080`      | Port to listen on.                                                                                             |
| `PARMANA_SERVICE_HOST`         | No              | `127.0.0.1` | Address to bind. Use `0.0.0.0` on a hosted service.                                                            |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | No              | `10000`     | Timeout for the upstream call.                                                                                 |

The service refuses to start when a required setting is missing, and the error names the setting but never its value.

### The MCP server

| Setting                         | Required | Purpose                                                 |
| ------------------------------- | -------- | ------------------------------------------------------- |
| `PARMANA_API_URL`               | Yes      | Parmana's API address. Must be `https`.                 |
| `PARMANA_API_KEY`               | Yes      | The caller's key for that API.                          |
| `PARMANA_AUTHORITY_ID`          | Yes      | The authority the calls are made under.                 |
| `PARMANA_AUTHORITY_TYPE`        | Yes      | `USER`, `ROLE`, `SERVICE` or `ORGANIZATION`.            |
| `PARMANA_PRINCIPAL_ID`          | Yes      | The principal the calls are made for.                   |
| `PARMANA_AUTHORIZATION_ID`      | Yes      | The authorization the calls belong to.                  |
| `PARMANA_AUTHORIZATION_PURPOSE` | Yes      | A short sentence stating why the actions are requested. |
| `PARMANA_CONNECTOR_MANIFEST`    | Yes      | Path to the manifest whose capabilities become tools.   |
| `PARMANA_SOURCE_SYSTEM`         | No       | Defaults to `parmana-connect`.                          |
| `PARMANA_SUBMITTED_BY`          | No       | Defaults to the principal.                              |

Start the MCP server with `npm run mcp`.

### Check the configuration

Run `npm run doctor` before starting the service. It runs every configuration check and lists all the problems at once, each with a fix. It never prints a secret value.

Set `PARMANA_EXPECTED_KEY_FINGERPRINT` and `PARMANA_EXPECTED_AUDIENCE` to pin the key and the audience. With those set, the service refuses to start when either differs from the pinned value. Without them, `doctor` warns that the values were not compared, and the service starts as before.

### What doctor checks

Offline, `npm run doctor` checks:

- Node.js 24 or later
- the bearer token: present, at least 32 characters, and random enough (not a repeated character)
- the policy folder: set and exists (the service needs the folder, not files in it)
- the public key file: holds a public Ed25519 key, not a private key, and matches the pinned fingerprint if one is set
- the connector manifest, and that its upstream credential is set
- the release audience: present and https, and equal to the pinned audience if one is set
- the nonce store, the port and the timeout
- every `PARMANA_` setting: a name no component reads is reported, with the closest real name as a suggestion

With `--online`, it also checks the key against parmana-core, the clock against parmana-core's, and the database: reachable, the nonce table present, and INSERT and DELETE granted to the database user. The privilege check reads the grants only, and writes no rows.

### Online checks

`npm run doctor` works offline. Add `--online` to also check against parmana-core and the database:

```bash
npm run doctor -- --online
```

- **parmana-core key.** Fetches the key parmana-core publishes for `PARMANA_CORE_KEY_ID` (default `default`) from `PARMANA_CORE_URL`, and compares it with `PARMANA_PUBLIC_KEY_FILE`. Set `PARMANA_CORE_URL` to the parmana-core API, not another site.
- **Clock.** Compares this machine's clock with the `Date` header parmana-core sends. A difference over 30 seconds fails.
- **Database.** Connects to `PARMANA_DATABASE_URL` and checks that the nonce table exists. Only the error code is printed, never the connection string.

Online checks that cannot run because a setting is missing show a warning, not a failure.

### What doctor still does not check

- **Other database permissions.** `--online` confirms the database is reachable, the table exists, and INSERT and DELETE are granted. It does not check any other privilege.
- **Clock accuracy.** The clock is compared with parmana-core's, which is good enough to catch drift. It is not checked against a time source you trust. Keep automatic time sync on.
- **Registration.** `doctor` does not check that the connector is registered in parmana-core. That is a step in the registration flow, not a configuration value.

## Deploying

[`docs/SETUP.md`](docs/SETUP.md) gives the full steps for a Windows computer and for Render's free tier, including the environment variables and the secret files. Set `PARMANA_SERVICE_HOST=0.0.0.0` on a hosted service, set the health check path to `/health`, and register the exact `/execute` URL in Parmana as the endpoint.

## Reference

- The `POST /execute` contract, with every check, answer, status code and limit: [docs/API.md](docs/API.md).
- The manifest format, its validation rules and what the generic connector does with each capability: [docs/MANIFEST.md](docs/MANIFEST.md).

## Documentation

| Document                                                                                      | For                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [Setup](docs/SETUP.md)                                                                        | Running the service locally and deploying it to Render, step by step                  |
| [Local keys](docs/LOCAL-KEYS-RUNBOOK.md)                                                      | Where keys live, how they are created, rotated and checked, and the errors they cause |
| [Execution service](docs/EXECUTION-SERVICE.md)                                                | What the service checks, its configuration, and its known limits                      |
| [End-to-end guide](docs/END-TO-END.md)                                                        | How the pieces fit, from manifest to signed record                                    |
| [MCP server](docs/MCP-SERVER.md)                                                              | The tools, their configuration, and each outcome an agent can see                     |
| [Objective and design](docs/OBJECTIVE.md)                                                     | The goal, the open decisions, and the build order                                     |
| [Beginner's book](docs/PARMANA-BEGINNERS-BOOK.md)                                             | A step-by-step guide for a new developer, with expected outcomes                      |
| [Progress report](docs/PROGRESS-REPORT.md)                                                    | What is done, why, and what is pending                                                |
| [Process record](docs/PROCESS-RECORD.md) and [full process guide](docs/FULL-PROCESS-GUIDE.md) | The full history of the setup, and its commands                                       |

## Layout

| Path                                               | Contents                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `schema/manifest.schema.json`                      | JSON Schema for manifests                                                                         |
| `src/manifest.ts`                                  | Loads and validates manifests                                                                     |
| `src/connector.ts`                                 | The generic connector: runs a manifest's capabilities over HTTP                                   |
| `src/execution-service.ts`                         | The service's route: verifies a signed release or a signed authorization, then runs the connector |
| `src/external-release.ts`                          | Verifies Parmana's signed releases: signature, audience, expiry and replay                        |
| `src/postgres-nonce-store.ts`                      | Shared replay store backed by PostgreSQL                                                          |
| `src/mcp-tools.ts`, `src/mcp-server.ts`            | MCP tools built from the manifest's capabilities                                                  |
| `src/parmana-client.ts`                            | HTTP client for Parmana's API                                                                     |
| `src/config.ts`, `src/mcp-config.ts`               | Environment configuration, which refuses invalid values                                           |
| `src/main.ts`, `src/mcp-main.ts`, `src/migrate.ts` | Entry points                                                                                      |
| `scripts/signed-request.mjs`                       | Sends one signed request to a running service, for a quick check                                  |
| `manifests/httpbin.json`                           | The manifest `.env.example` points to: one read capability, `httpbin:get`                         |
| `.github/CODEOWNERS`, `.github/dependabot.yml`     | Code owners for sensitive paths, and weekly dependency updates                                    |
| `tests/`                                           | Unit and integration tests                                                                        |

## Status

As of 2026-10-29:

- **Verified.** A signed release from Parmana's local API, under the `httpbin-read` policy, was released to a service on Render. The service verified it and ran the call, and the result was recorded as verified. A signed authorization sent directly to the service was accepted.
- **Verified by tests.** The release checks (signature, audience, expiry, replay), the manifest rules, the configuration rules, and the MCP tools.
- **Not yet done.** The service has not been run against a production Parmana deployment. Its real public key has not been installed. Replay protection on a single instance uses memory unless `PARMANA_NONCE_STORE=postgres` is set.
- **Hosting.** The free Render plan sleeps when idle, and the first request after a sleep can take about 50 seconds.
- **Sandbox.** The public sandbox's approved path could not be completed when it was last tested, because a table is missing on the sandbox side.

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Do not open a public issue for it.

- Never commit `.env`, anything in `keys/`, or any `*.pem` file. The `.gitignore` covers them, but check `git status` before every commit.
- The upstream credential is read from the service's environment and sent only to the upstream. The service's own error messages name the setting, never its value. An upstream service that echoes request headers can still return the credential, so use a test value for a public test service.
- A release is authenticated by its signature, not by a shared secret. The service accepts only releases signed by the key it was given, addressed to its own URL, unexpired, and not yet run.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Commits need a `Signed-off-by` line that matches the author, because the project uses the Developer Certificate of Origin.

## License

Apache-2.0, as declared in `package.json`. The licence text is in [LICENSE](LICENSE).
