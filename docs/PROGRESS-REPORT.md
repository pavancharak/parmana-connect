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

- A proposal for `httpbin:get` was created, approved by `local-approver`, and is now `active`.

## How and why

- **Signed-request test first.** It checks the service accepts a correctly signed request before `parmana-core` is added to the chain.
- **Render, not a local tunnel.** `parmana-core` accepts external endpoints only on public `https` domains, so `localhost` is refused.
- **Two-person approval.** Registration needs a proposer and a different approver with a step-up signature. Both keys are on the same machine here, so this run is not a real two-person review.

## Pending

1. **Policy rule for `httpbin:get`.** Blocker. `connector-capability` only allows `crm:read` and `payments:refund`, so `parmana-core` rejects `httpbin:get`. Adding a rule is a policy change with its own approvals.
2. **End-to-end test through `parmana-core`.** Waits on item 1.
3. **Regenerate the proposer key.** Its raw key was shown in chat. Treat it as exposed. It works only against the local API.
4. **Open PRs for the docs branches.** `docs/process-record-update` (commit `34110a3`) and `docs/full-process-guide` (commit `5604ea9`) are pushed but not opened as PRs. The record also needs its Prettier warning fixed.
5. **Document `PARMANA_SERVICE_HOST`** in `docs/SETUP.md` and `docs/EXECUTION-SERVICE.md`.
6. **Real Parmana public key.** The test key is not Parmana's. Real requests are refused until it is replaced.
7. **Production limits.** Render's free tier sleeps after about 15 minutes idle. `PARMANA_NONCE_STORE=memory` protects only one instance from replay.
8. **Dependabot alert #5.** Confirm it is closed.
9. **Optional cleanup.** Delete the empty fork branch `claude/parmana-core-385-note` in `pavancharak/integrations`.
