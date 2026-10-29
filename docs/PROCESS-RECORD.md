# Process record: parmana-core, parmana-connect and the Render deploy

Date of record: 2026-10-29. This document covers what was done, why, the commands used, the problems met and how they were fixed, what is working, and what is left.

---

## 1. Goal

Make it possible for a team to run Parmana's execution path end to end:

1. `parmana-core` decides whether an action is allowed and signs an authorization.
2. `parmana-connect` receives the signed request, checks it, and runs the real upstream call.
3. The service runs somewhere reachable over `https`, so `parmana-core` can call it.

Two repositories were involved:

| Repository | Local folder (Windows) | Role |
| --- | --- | --- |
| `pavancharak/parmana-core` | `D:\last\parmana-core` | Policy, signing, keys |
| `pavancharak/parmana-connect` | `D:\last\parmana-connect` | Execution service that runs connectors |

---

## 2. Work already merged (earlier phases)

These were finished before the deploy work. Each item lists the PR and what it did.

### parmana-core

| PR | What | Why |
| --- | --- | --- |
| #197 | Packages made publishable (`private: true` removed, licence files added) | So npm could publish the core packages |
| #198 | SDK version set to 1.6.2 across npm and Python packages | One version number for the release |
| #199, #200 | Docs updated for the 1.6.2 SDK and the published packages | Docs matched the releases |
| #201 | Release runbook for every package | So the next release can be repeated |
| #202 | `qs` override raised to `^6.16.1`, plus `docs/runbooks/NPM-AUDIT-RECORD.md` | Clears GitHub Dependabot alert #5 (GHSA-6pq8-jhm2-2vcw) |

Closed without merging:
- **#204**, a docs PR opened from the wrong patch. Closed on 2026-10-29. Its branch `claude/parmana-core-385-note` was deleted, and `git ls-remote` confirmed it is gone.

### parmana-connect

| PR | What | Why |
| --- | --- | --- |
| #9 | `CONTRIBUTING.md` | How changes reach `main` and which checks are required |
| #10 | `.gitignore` ignores `.env`, `.env.*` (except `.env.example`), `keys/`, `*.pem` | So a token or key cannot be committed by accident |
| #11 | `scripts/signed-request.mjs` | Sends one signed, approved request to the service, for testing |
| #12 | `docs/SETUP.md` and `.env.example` | Setup and deploy steps in one place |
| #13 | `PARMANA_SERVICE_HOST` setting; `src/main.ts` binds to it | Render could not reach a service bound to `127.0.0.1` |

### agentrust-io/integrations

- **#385** (PR by pavancharak from a fork, merged by rajnisht7): changed one line in `integrations/parmana-server/integration.yaml` so the repository link points to the Apache-2.0 `parmana-core`. Merged. You do not need to do anything else in that repository.

---

## 3. The local test setup (Windows)

### What exists in `D:\last\parmana-connect`

| Path | What it is | Made by |
| --- | --- | --- |
| `.env` | Bearer token, key path, manifest path, policy folder, nonce store, test upstream secret | Part 1 Step 6 of `docs\SETUP.md` |
| `keys\parmana-public.pem` | Ed25519 public key the service checks signatures with. Copied from `parmana-core\keys\default.public.pem` | Copy step, see section 6 |
| `manifests\httpbin.json` | Connector manifest. Calls `https://httpbin.org/get`, a public echo service, for testing only | Part 1 Step 5 |
| `policies\` | Empty folder. The service requires `PARMANA_POLICY_DIR` to exist | Part 1 Step 3 |
| `dist\` | Build output from `npm run build` | Part 1 Step 2 |
| `scripts\signed-request.mjs` | Test script that signs a request with `default.private.pem` | Merged in PR #11 |

### Keys in `D:\last\parmana-core\keys`

| File | Used for |
| --- | --- |
| `default.private.pem` | Created on 2026-10-29 to replace the missing private key. The matching public key is `default.public.pem` |
| `default.public.pem` | Replaced on 2026-10-29. The old file is saved as `default.public.pem.bak` |
| `gateway.*.pem` | A different key, for connector identity. Not used here |

Note: creating a new key pair replaces the old public key. Any signature made with the old key no longer verifies against `default.public.pem`. To undo this, copy `default.public.pem.bak` back to `default.public.pem`.

---

## 4. The Render deploy

### Service settings

| Setting | Value |
| --- | --- |
| Service name | `parmana-connect` |
| Repository and branch | `pavancharak/parmana-connect`, `main` |
| Runtime | Node |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start` |
| Plan | Free ($0 / month) |
| Health Check Path | Empty. The service has no `/healthz` route |
| Public address | `https://parmana-connect.onrender.com` |
| Region | Singapore |

### Environment variables

| Key | Value | Purpose |
| --- | --- | --- |
| `NODE_VERSION` | `24` | Node version for the build |
| `PARMANA_SERVICE_PORT` | `10000` | Render routes traffic to port 10000 |
| `PARMANA_SERVICE_HOST` | `0.0.0.0` | Listen on all interfaces, so Render can reach the service |
| `PARMANA_SERVICE_BEARER_TOKEN` | Same value as the token in local `.env` | Must match exactly |
| `PARMANA_PUBLIC_KEY_FILE` | `/etc/secrets/parmana-public.pem` | Path of the secret file |
| `PARMANA_CONNECTOR_MANIFEST` | `/etc/secrets/httpbin.json` | Path of the secret file |
| `PARMANA_POLICY_DIR` | `.` | An existing folder |
| `PARMANA_NONCE_STORE` | `memory` | Single instance only. See section 8 |
| `HTTPBIN_TOKEN` | `test-only-not-a-real-secret` | Upstream value for the test manifest |

### Secret files

| Filename | Contents |
| --- | --- |
| `parmana-public.pem` | The full text of `keys\parmana-public.pem` |
| `httpbin.json` | The full text of `manifests\httpbin.json` |

### Deploy history (from the Render page)

- Earlier failed deploys: the service was first created without the right port, and without the host setting. Both were set and redeployed.
- Deploy `bddbbd8` (merge of PR #13) is **Live**.
- The Render dashboard also shows two other services, `parmana-paytm-agent` and `menthor-backend`, both suspended. They were not changed.

---

## 5. Commands, in the order they were used

### Check Node and install (Windows PowerShell)

```powershell
node -v
cd D:\last\parmana-connect
npm ci
npm run build
```

`node -v` must print `v24.x`.

### Create folders

```powershell
New-Item -ItemType Directory -Force keys, manifests, policies | Out-Null
```

### Create the public key file (test key)

```powershell
node -e "const c=require('crypto');const {publicKey}=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('keys/parmana-public.pem',publicKey.export({type:'spki',format:'pem'}))"
```

### Create the connector manifest

```powershell
@"
{
  "system": "httpbin",
  "baseUrl": "https://httpbin.org",
  "apiVersion": "1",
  "credential": { "type": "bearer", "secretRef": "HTTPBIN_TOKEN" },
  "capabilities": [
    { "id": "httpbin:get", "method": "GET", "path": "/get", "effect": "read" }
  ]
}
"@ | Set-Content -Path manifests\httpbin.json -Encoding ascii
```

### Write `.env`

```powershell
$token = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

@"
PARMANA_SERVICE_BEARER_TOKEN=$token
PARMANA_PUBLIC_KEY_FILE=keys\parmana-public.pem
PARMANA_CONNECTOR_MANIFEST=manifests\httpbin.json
PARMANA_POLICY_DIR=policies
PARMANA_NONCE_STORE=memory
HTTPBIN_TOKEN=test-only-not-a-real-secret
"@ | Set-Content -Path .env -Encoding ascii
```

Use `-Encoding ascii`. `-Encoding utf8` writes a byte-order mark, which made the first setting unreadable.

### Start the service locally

```powershell
node --env-file=.env dist/main.js
```

Expected output: `execution service listening on port 8080`.

### Test the service locally

```powershell
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Expected output: `"success": true` and `"status": 200`. This passed.

### Test that the service rejects an empty request

```powershell
try {
  Invoke-WebRequest http://localhost:8080/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: `401`. This passed.

Note: Windows PowerShell 5.1 has no `-SkipHttpErrorCheck`. Use the `try` / `catch` form above.

### Test the public address

```powershell
try {
  Invoke-WebRequest https://parmana-connect.onrender.com/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: `401`. This passed on 2026-10-29. The first request after an idle period can take about 50 seconds.

### Send a signed request to the public address

```powershell
$env:PARMANA_SERVICE_URL = "https://parmana-connect.onrender.com"
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Expected: `"success": true` and `"status": 200`. **Current result: `Refused or failed: Execution System returned HTTP 401.`** See section 7.

### Git commands used for merges and branches

```powershell
git pull origin main
git checkout -B <branch> origin/main
git add <files>
git -c user.name="Pavan Dev Singh Charak" -c user.email="charak1987@gmail.com" commit -F <message file>
git push -u origin <branch>
```

Every commit has a `Signed-off-by` line that matches the author.

---

## 6. Problems met and how they were fixed

| Problem | Cause | Fix |
| --- | --- | --- |
| `PARMANA_SERVICE_BEARER_TOKEN is required` even with `.env` present | `Set-Content -Encoding utf8` added a byte-order mark to the first line | Rewrite `.env` with `-Encoding ascii` |
| `fetch failed` from the test script | The service was not running | Start the service in a separate window first |
| `Invoke-WebRequest: parameter not found: SkipHttpErrorCheck` | Windows PowerShell 5.1 does not have that option | Use `try` / `catch` and read `StatusCode.value__` |
| `git pull` refused: `docs/SETUP.md` would be overwritten | A copy of the file already existed untracked | Move the copy aside, pull, then delete the copy |
| `git am` failed: `docs/CURRENT-STATE.md: does not exist in index` | The patch was written for `parmana-core`, applied to `parmana-connect`/`integrations` | Stopped. The note was written in the agentrust repository instead |
| A branch was pushed to the wrong repository | The clone's `origin` was `parmana-core`, not `integrations` | Branch deleted. Checked each `origin` URL before pushing afterwards |
| `--force-with-lease` overwrote a remote branch | The command was run without checking the remote first | The old commit `af321fe` stays in the local reflog |
| Stop hook: "untracked files" / "uncommitted changes" | Work was left in the working tree | Commit to a new branch from `main`, then open a PR, after you said yes |
| `git push --force` / delete denied by permission system | The session blocked a remote branch delete | Deleted the branch in the GitHub web interface |
| Render: "No open ports detected on 0.0.0.0" | The service bound to `127.0.0.1` (the default) | PR #13 added `PARMANA_SERVICE_HOST`. Set it to `0.0.0.0` on Render |
| Render logs port 8080 while Render expects 10000 | `PARMANA_SERVICE_PORT` was not set on Render | Added `PARMANA_SERVICE_PORT=10000` |
| Render health check failing | Health check path `/healthz`, which the service does not serve | Cleared the field |
| Render repository not in the list | Render did not have access to `parmana-connect` | Credentials → Configure in GitHub → added the repository |
| `claude remote-control` said "must be logged in" | No claude.ai login on this computer | `claude auth login`, then `claude remote-control` |
| Computer-folder tool listed no folders | That tool only lists Mac or Linux folders | Not available for this Windows folder. Run commands yourself |
| `Refused or failed: Execution System returned HTTP 401` on the public address | The bearer token in local `.env` and on Render probably differ | See section 7 and check the token |
| `prettier --write` changed about 60 unrelated lines | The files already failed the formatting check | Reverted, and applied only the intended edits |

---

## 7. Current problem: 401 on the signed request

What we know:
- The unsigned request to `https://parmana-connect.onrender.com/execute` returns `401`. The service is reachable.
- The signed request passed locally, against `http://localhost:8080`, with the same `.env`.
- The signed request to the public address returns `Execution System returned HTTP 401`.

Most likely cause: the bearer token in Render's `PARMANA_SERVICE_BEARER_TOKEN` does not match the token in local `.env`. `.env` was regenerated at least once after Render was set up, and Render keeps the value it was given.

Fix:

1. In PowerShell, print the local token:

   ```powershell
   Select-String -Path D:\last\parmana-connect\.env -Pattern "^PARMANA_SERVICE_BEARER_TOKEN="
   ```

2. Copy the value after `=`. Do not paste it into chat.
3. In Render, open the service, go to **Environment**, click `PARMANA_SERVICE_BEARER_TOKEN`, paste the copied value, and save.
4. Redeploy and wait until it says **Live**.
5. Run the signed-request command again.

If it still returns `401`, check the other possibility: the public key. The Render secret file `parmana-public.pem` must match `keys\parmana-public.pem`. Compare the first line, which must be `-----BEGIN PUBLIC KEY-----`, and the last line.

---

## 8. Limits of the current setup

- **Free tier sleep.** The service stops after about 15 minutes without traffic. The first request after that can take about 50 seconds.
- **Test key.** `keys\parmana-public.pem` was generated for testing and does not match the real Parmana deployment. Real requests from a Parmana operator will fail against it.
- **Memory nonce store.** `PARMANA_NONCE_STORE=memory` only protects against replayed requests inside one running instance. Use `postgres` with a shared database before running more than one instance.
- **Test upstream.** The manifest calls `httpbin.org`, a public echo service. Its response shows the request headers, so it must never receive a real credential.
- **Documentation gap.** `docs/SETUP.md` and `docs/EXECUTION-SERVICE.md` do not yet describe `PARMANA_SERVICE_HOST`. PR #13 says so.

---

## 9. What is achieved

- `parmana-core` packages, the 1.6.2 SDK and the release runbook are merged and published.
- The `qs` vulnerability (Dependabot alert #5) is fixed in `main` by PR #202. GitHub should close the alert when it next scans `main`. This record does not confirm that it has closed.
- `parmana-connect` runs locally. A signed request passed end to end with `status 200`.
- `parmana-connect` runs on Render at `https://parmana-connect.onrender.com`. Unsigned requests get `401`, so the service is reachable from the internet.
- Setup steps, example env file and the `scripts\signed-request.mjs` test are all merged in `main`.

---

## 10. What is left

| # | Item | Who | Notes |
| --- | --- | --- | --- |
| 1 | Fix the bearer token mismatch on Render (section 7) | You | Then the signed request should return 200 |
| 2 | Add `PARMANA_SERVICE_HOST` to `docs/SETUP.md` and `docs/EXECUTION-SERVICE.md` | Me, with your yes | A small docs PR |
| 3 | Register `https://parmana-connect.onrender.com` as an external connector in `parmana-core` | You, with an admin key | Needs a user (human) key. Service keys are refused for this |
| 4 | Replace the test public key with the Parmana operator's public key | You, from the operator | Only the public key, never the private key |
| 5 | Switch `PARMANA_NONCE_STORE` to `postgres` before more than one instance runs | You and me | Needs a shared database |
| 6 | Delete the empty fork branch `claude/parmana-core-385-note` in `pavancharak/integrations` (optional) | You | It has no changes |
| 7 | Check Dependabot alert #5 is closed | You | Open https://github.com/pavancharak/parmana-core/security/dependabot/5 |
| 8 | Decide whether to pay for Render (Starter, $7/month) to avoid the sleep | You | Free tier sleeps |
| 9 | Decide when to rotate `default.private.pem` (new key pair created 2026-10-29) | You | Old key is in `default.public.pem.bak` |
| 10 | Run the end-to-end test through local `parmana-core`. Blocked: `connector-capability` 1.1.0 has rules only for `crm:read` and `payments:refund`, so `httpbin:get` falls through to `reject-default`. Next: add a rule for `httpbin:get` through the policy change flow (maker, checker, step-up), then send an action through `parmana-core` `/execute` | You, with me | The connector is registered and approved in the local API: change `a03974db-e207-4961-97d0-0647de802707`, status active. Approval of the policy change needs a second human and a step-up key |

---

## 11. Quick checklist for the next session

1. Confirm the Render service is **Live**.
2. Run the empty-request test. Expect `401`.
3. Make sure the bearer tokens match (section 7).
4. Run the signed-request command against `https://parmana-connect.onrender.com`. Expect `"status": 200`.
5. If it passes, do item 3 in section 10.
