# Remaining work

Status as of 2026-11-07.

## Done and on main

- **Release-only is the default (PR #47, `43679bd`).** `PARMANA_RELEASE_ONLY` now defaults to `true`. Release-only without an audience still fails at startup. Setting it to `false` turns the bearer path back on. PR #46 was closed in favour of #47.
- **Bearer path closed by release-only (PR #32, `8baeefd`).** With `PARMANA_RELEASE_ONLY=true`, a request with only a bearer token is refused with 403, so a signed, approved release is the only route to the connector.
- **Release lifecycle checks (PR #32).** Releases over 4096 bytes are accepted as SHA-512 commitments, as parmana-core signs them. A repeated release is answered with its first stored result, not refused. Tests: `tests/release-only.test.ts`, `tests/core-fixtures.test.ts`, `tests/release-ledger.test.ts`.
- **Manifest read and write labels enforced (PR #36, `056e8ac`).** A capability marked `effect: read` can only use `GET`. Each refused combination has a test.

## Deploy note: check before the next deploy

The default change refuses bearer-only requests that used to pass. A deployment that still relies on the bearer path must set `PARMANA_RELEASE_ONLY=false` deliberately, or move its callers to signed releases first. Confirm this before turning the change on in production.

The Render service still accepts the bearer path until the new code is deployed and the setting is turned on.

## Open

- **Node version range.** `package.json` `engines.node` is `>=24`, which allows a newer major than the one tested. parmana-core pinned its range to `24.x` on 2026-11-07 (PR #489). The same change here would keep the connector on the tested major. Needs a decision, then one change to `engines` and the CI pin together.

- **No live run between parmana-core and this connector.** External registration needs a public HTTPS endpoint, and this connector cannot be registered from a local machine. The fixture tests use parmana-core's source, not a running instance. Closing it needs either a public endpoint for the connector or a decision to deploy it for this purpose.
- **Production public key not installed or pinned.** `PARMANA_EXPECTED_KEY_FINGERPRINT` is unset, so the connector accepts any release signed by the key it was given. Closing it needs parmana-core's public key fingerprint, confirmed through a second channel, set on the connector.
- **One shared token for the MCP server.** The MCP HTTP mode uses one bearer token for every client. Per-client tokens are an open decision.

## Node version

Run the test suite on Node 24 or later, as the project requires.
