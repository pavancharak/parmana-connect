# Progress report: parmana-connect and parmana-core

Date: 2026-10-29

## Goal

Get `parmana-connect` (the service that runs connector calls) reachable on the internet, then register it with the local `parmana-core` API so `parmana-core` can call it.

## Completed

### Code and repositories

- `parmana-core`: the SDK, release docs and the `qs` security fix (PR #202) are merged. Dependabot alert #5 should close on its next scan. Not confirmed.
- `parmana-connect`: PRs #9 to #14 are merged. They cover contributing rules, ignoring secrets, the signed-request test script, the setup guide, the host setting and the process record.
- agentrust-io link (#385): merged by the maintainer. Nothing more is needed there.

### Local setup (your computer)

- `parmana-connect` runs on port 8080. A signed request passes with status 200.
- `parmana-core` database runs in Docker. The API runs on port 3000. Health check returns `UP`.
- Caller keys: `local-proposer` (proposes) and `local-approver` (approves, with a step-up key).

### Render

- `https://parmana-connect.onrender.com` is live. An unsigned request returns 401, so it is reachable.
- A signed request returned 200 on the second attempt, after the bearer token on Render was corrected.

### Connector registration

- The first registration of `httpbin:get` pointed at `https://parmana-connect.onrender.com/` (no `/execute`). Signed releases were sent to that URL and refused (`502`). Revoked.
- The `httpbin-read` policy was proposed and approved (version 1.0.0).
- A second registration of `httpbin:get` points at `https://parmana-connect.onrender.com/execute` under `httpbin-read`. Approved, and active.
- Signed releases use parmana-core's external connector protocol (ADR-0013). `parmana-connect` accepts them since PR #18, and `PARMANA_RELEASE_AUDIENCE` is set on Render.

### End-to-end result (2026-10-29)

- A request through `parmana-core` `/execute` for `httpbin:get`, with an approval signed by `local-issuer`, returned `200`.
- The execution is `COMPLETED`, and its verification is `VERIFIED`. The trust record and receipt are signed by `parmana-core`.
- `parmana-connect` on Render received the release at `https://parmana-connect.onrender.com/execute`, ran the connector, and returned `200` from `httpbin.org`.

### Merged in this stage

- `parmana-connect` PR #17 (full process guide), #18 (external release protocol), #19 (environment variables in the setup guide).

## How and why

- **Signed-request test first.** It checks the service accepts a correctly signed request before `parmana-core` is added to the chain.
- **Render, not a local tunnel.** `parmana-core` accepts external endpoints only on public `https` domains, so `localhost` is refused.
- **Two-person approval.** Registration needs a proposer and a different approver with a step-up signature. Both keys are on the same machine here, so this run is not a real two-person review.

## Pending

1. **Regenerate the proposer key.** Its raw key was shown in chat several times. Treat it as exposed. It works only against the local API.
2. **Open PRs for the docs branches.** `docs/process-record-update` (commit `34110a3`) and `docs/full-process-guide` (commit `5604ea9` was merged as PR #17). The record needs its Prettier warning fixed.
3. **Document the release protocol** in `docs/EXECUTION-SERVICE.md`, including `PARMANA_RELEASE_AUDIENCE`.
4. **Real Parmana public key.** The test key is not Parmana's. Real requests are refused until it is replaced.
5. **Production limits.** Render's free tier sleeps after about 15 minutes idle. `PARMANA_NONCE_STORE=memory` protects only one instance from replay.
6. **Approval issuer.** `local-issuer` is a local test issuer, added through maker and checker. A real deployment needs an issuer that the operator controls.
7. **Dependabot alert #5.** Confirm it is closed.
8. **Optional cleanup.** Delete the empty fork branch `claude/parmana-core-385-note` in `pavancharak/integrations`.
