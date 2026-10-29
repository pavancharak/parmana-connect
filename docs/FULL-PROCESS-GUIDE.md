# Full process guide: parmana-core, parmana-connect, the Render deploy, and the connector registration

Record date: 2026-10-29. Machine: Windows, PowerShell. Folders: `D:\last\parmana-core` and `D:\last\parmana-connect`.

This guide explains each part in the order it happened: what it is, why it is needed, the exact commands, what the output should look like, and what to do when it goes wrong. It is accurate to the commands and outputs recorded in this session. Where something was not confirmed, it says so.

---

## 0. Contents

1. What the system is, in one page
2. Where each piece runs
3. Repositories and merged changes
4. Keys and secrets: what each one is, where it lives, what must never be shared
5. Part A: `parmana-connect` on your computer
6. Part B: `parmana-connect` on Render
7. Part C: `parmana-core` API on your computer
8. Part D: registering `parmana-connect` as a connector
9. Part E: the signed-request test
10. Troubleshooting index (every error seen, and the fix)
11. Current state
12. What is left

---

## 1. What the system is, in one page

Parmana decides whether an agent may run an action, and it signs the decision. The runtime that calls the upstream system is a **connector**.

- **`parmana-core`** holds the policy rules, the signing keys and the API. Its API has a database (Postgres, run in Docker on your computer).
- **`parmana-connect`** is the execution service. It receives a signed authorization, checks the signature and expiry, and runs the upstream call described in a manifest. It knows nothing about policy.
- **The manifest** (`manifests\httpbin.json`) describes one upstream system and its capabilities. Our test manifest calls `https://httpbin.org/get`, a public echo service.
- **The connector registration** tells `parmana-core` that a capability, `httpbin:get`, is served by an HTTPS endpoint, `https://parmana-connect.onrender.com/`. Registration needs a proposal by one human and an approval by a different human, with a step-up signature.
- **The policy** (`connector-capability`) decides whether an action is allowed. A registration does not allow anything by itself.

Flow when everything is working:

```
agent request -> parmana-core /execute
                   policy decides ALLOW, signs authorization
                 parmana-core -> parmana-connect (Render, https)
                   service checks bearer token, signature, expiry, nonce
                   service runs the manifest call -> httpbin.org
                 result returns to parmana-core
```

What works today: the service accepts a correctly signed request end to end (section 9). The registration exists in the local API (section 8). What does not work yet: `parmana-core` deciding to allow `httpbin:get`, because the policy has no rule for it (section 8.4).

---

## 2. Where each piece runs

| Piece | Where | Address | Notes |
| --- | --- | --- | --- |
| `parmana-connect` service, local | Your computer, `node dist/main.js` | `http://localhost:8080` | Test only |
| `parmana-connect` service, public | Render free web service | `https://parmana-connect.onrender.com` | Sleeps after about 15 minutes idle; first request can take about 50 seconds |
| `parmana-core` Postgres | Docker container `parmana-postgres-1` | `127.0.0.1:55432` | From `docker-compose.yml` |
| `parmana-core` API | Your computer, `npm run dev` | `http://localhost:3000` | Needs the `.env` file and at least one caller key |
| GitHub | `pavancharak/parmana-connect` and `pavancharak/parmana-core` | Web | PRs are opened and merged here |

---

## 3. Repositories and merged changes

### parmana-core

| PR | Result | What |
| --- | --- | --- |
| #197 | Merged | Core packages made publishable |
| #198 | Merged | SDK version 1.6.2 across packages |
| #199, #200 | Merged | Docs for the 1.6.2 SDK and published packages |
| #201 | Merged | Release runbook for all packages |
| #202 | Merged, 2026-10-28 | `qs` override raised to `^6.16.1`, and `docs/runbooks/NPM-AUDIT-RECORD.md`. Clears Dependabot alert #5 (GHSA-6pq8-jhm2-2vcw). The alert should close on the next scan. Not confirmed here |
| #204 | Closed, not merged | Wrong note, opened from a patch meant for another repository. Its branch was deleted |

### parmana-connect

| PR | Result | What |
| --- | --- | --- |
| #9 | Merged | `CONTRIBUTING.md` |
| #10 | Merged | `.gitignore` ignores `.env`, `.env.*` (except `.env.example`), `keys/`, `*.pem` |
| #11 | Merged | `scripts/signed-request.mjs`, the signed-request test |
| #12 | Merged | `docs/SETUP.md` and `.env.example` |
| #13 | Merged | `PARMANA_SERVICE_HOST` setting, so the service can bind to `0.0.0.0` on Render |
| #14 | Merged | `docs/PROCESS-RECORD.md` |
| (branch only) | Pushed, PR not opened | `docs/process-record-update`, commit `34110a3`. Adds the policy blocker to section 10 of the record |

### agentrust-io/integrations

- **#385** (merged by rajnisht7): one-line change in `integrations/parmana-server/integration.yaml` that points the repository link at `parmana-core`. Nothing further is needed.

---

## 4. Keys and secrets

Each secret has one purpose. Never paste a raw key, a private key, or a full `.env` into chat or a commit.

| Name | What it is | Where it lives | Who holds it |
| --- | --- | --- | --- |
| `default.private.pem` | Private Ed25519 key. Parmana signs authorizations with it | `D:\last\parmana-core\keys\` | You only |
| `default.public.pem` | Public half of the above. The service checks signatures with it | `D:\last\parmana-core\keys\`, copied to `parmana-connect\keys\parmana-public.pem` | Can be shared |
| `default.public.pem.bak` | The old public key, before 2026-10-29 | `D:\last\parmana-core\keys\` | You only |
| `parmana-public.pem` (Render secret file) | Same content as `keys\parmana-public.pem` | Render, mounted at `/etc/secrets/` | Render |
| `PARMANA_SERVICE_BEARER_TOKEN` | Shared secret that `parmana-core` sends to the service | `parmana-connect\.env`, and Render's environment | Must match on both sides |
| `HTTPBIN_TOKEN` | Upstream value for the test manifest. Not a real secret | `.env` and Render | Test value only |
| Caller raw key (proposer) | Password for the local API as `local-proposer`. **Shown in this chat on 2026-10-29. Treat as exposed** | Your saved note | You |
| Caller raw key (approver) | Password for the local API as `local-approver`. Entered at a prompt, not pasted | Your saved note | You |
| Caller hash (both) | SHA-256 of a raw key, 64 hex characters | `parmana-core\.env`, in `PARMANA_API_KEYS` | Can be shared, but not needed by anyone else |
| `keys\approver-stepup.private.pem` | Private Ed25519 key that signs the approval step | `D:\last\parmana-core\keys\` | You only |
| `keys\approver-stepup.public.pem` | Public half. Stored as `stepUpPublicKey` for `local-approver` | `parmana-core\keys\`, and `.env` | Can be shared |

Two rules that apply everywhere:

- Create `.env` with `Set-Content -Encoding ascii`. Windows PowerShell 5.1 writes a byte-order mark with `utf8`, which breaks the first setting.
- Before committing anything, run `git status`. `.env`, `keys\` and `*.pem` must not appear.

---

## 5. Part A: `parmana-connect` on your computer

### What it is and why

The execution service, run locally. It proves the code and the keys work before anything goes to Render.

### A1. Check Node

```powershell
node -v
```

Expected: `v24.` and a number. Node 22 is not supported. `re2` built under Node 22 fails under Node 24 with `ERR_DLOPEN_FAILED`.

### A2. Install and build

```powershell
cd D:\last\parmana-connect
npm ci
npm run build
```

Expected: no errors at the end of `npm run build`. It produces `dist\main.js`.

### A3. Make the folders

```powershell
New-Item -ItemType Directory -Force keys, manifests, policies | Out-Null
```

`policies` must exist, because the service requires `PARMANA_POLICY_DIR` to point at an existing folder.

### A4. Create the public key file (test key)

```powershell
node -e "const c=require('crypto');const {publicKey}=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('keys/parmana-public.pem',publicKey.export({type:'spki',format:'pem'}))"
```

Why: the service checks each signature with this key. This command makes a test key. It is later replaced with the key that matches `parmana-core`'s signing key (A6).

### A5. Create the manifest

The manifest is the file `manifests\httpbin.json`, created with this command:

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

Why each field: `system` must be a prefix of each capability `id`. `credential.secretRef` names the environment variable the service reads for the upstream token (`HTTPBIN_TOKEN`). `baseUrl` must be `https`.

### A6. Use the same public key as `parmana-core`

```powershell
Copy-Item D:\last\parmana-core\keys\default.public.pem D:\last\parmana-connect\keys\parmana-public.pem -Force
Get-Content D:\last\parmana-connect\keys\parmana-public.pem -TotalCount 1
```

Expected first line: `-----BEGIN PUBLIC KEY-----`.

Why: a signature made with `default.private.pem` only verifies with `default.public.pem`. The test key from A4 would refuse every real request.

### A7. Write `.env`

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

Every time this runs, it creates a **new** token. Render then needs the same new value (see B3, and troubleshooting T-7).

### A8. Start the service

```powershell
node --env-file=.env dist/main.js
```

Expected: `execution service listening on port 8080`. Leave the window open.

Why `--env-file`: `npm start` does not read `.env`. The service reads only the environment, so Node has to load the file.

### A9. Send a signed request

Second window:

```powershell
cd D:\last\parmana-connect
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Expected: `"success": true` and `"status": 200`. It signed the request with `default.private.pem`, so the check passed against `parmana-public.pem`.

What the script does (in order): it reads the token and paths from the environment; it builds an `ExecutableContent` from the action, target and parameters; it hashes it; it signs an authorization with the private key, valid 60 seconds; and it posts to `${PARMANA_SERVICE_URL}/execute` with `Authorization: Bearer <token>`.

### A10. Check the service rejects an empty request

```powershell
try {
  Invoke-WebRequest http://localhost:8080/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: `401`. An empty body has no authorization, so the service refuses it.

Note: Windows PowerShell 5.1 has no `-SkipHttpErrorCheck`. Use `try` and `catch`.

---

## 6. Part B: `parmana-connect` on Render

### What it is and why

The same service, on the internet, so `parmana-core` can reach it. Render's free tier is used.

### B1. Create the service

1. Render dashboard, **New → Web Service**.
2. In the Git Provider list, the repository was not visible at first. Open the **Credentials** dropdown → **Configure in GitHub** → add `parmana-connect` to the repositories Render can read. Do not choose **Disconnect credential**, which would also break `parmana-paytm-agent`.
3. Choose `pavancharak/parmana-connect`.
4. Set:
   - Name: `parmana-connect`
   - Branch: `main`
   - Language: Node
   - Build Command: `npm ci && npm run build`
   - Start Command: `npm run start`
   - Health Check Path: `/health`. The service answers `GET /health` with `{"status":"UP"}`.
   - Instance type: **Free** (check the price line shows $0)

### B2. Environment variables

| Key | Value | Why |
| --- | --- | --- |
| `NODE_VERSION` | `24` | Build and run on Node 24 |
| `PARMANA_SERVICE_PORT` | `10000` | Render routes traffic to 10000 |
| `PARMANA_SERVICE_HOST` | `0.0.0.0` | Listen on all interfaces. The default `127.0.0.1` is unreachable from Render |
| `PARMANA_SERVICE_BEARER_TOKEN` | Value of the same key in local `.env` | Must match exactly |
| `PARMANA_PUBLIC_KEY_FILE` | `/etc/secrets/parmana-public.pem` | Secret file path |
| `PARMANA_CONNECTOR_MANIFEST` | `/etc/secrets/httpbin.json` | Secret file path |
| `PARMANA_POLICY_DIR` | `.` | Any existing folder |
| `PARMANA_NONCE_STORE` | `memory` | One instance only (see section 11) |
| `HTTPBIN_TOKEN` | `test-only-not-a-real-secret` | Upstream test value |

Do not use **Add from .env**. It uploads the whole local file, including the token.

### B3. Secret files

Under **Advanced → Secret Files**, add two files:

- `parmana-public.pem` with the full text of `D:\last\parmana-connect\keys\parmana-public.pem`
- `httpbin.json` with the full text of `D:\last\parmana-connect\manifests\httpbin.json`

Copy the text from Notepad, select all, paste. Render mounts secret files under `/etc/secrets/`.

### B4. Deploy and check the logs

Click **Deploy web service**. The log should end with:

```
execution service listening on port 10000
```

Then Render should show the service as **Live**.

What went wrong on the way, and the fix:

- `listening on port 8080`, and "No open ports detected on 0.0.0.0": `PARMANA_SERVICE_PORT` was missing. Set it to `10000`.
- "Detected open ports on localhost": the service bound to `127.0.0.1`. PR #13 added `PARMANA_SERVICE_HOST`, and it must be `0.0.0.0` on Render.
- "Timed Out" and an instance restart: caused by the same port problem.

### B5. Test the public address

```powershell
try {
  Invoke-WebRequest https://parmana-connect.onrender.com/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: `401`. Reached on 2026-10-29. The first request after an idle period can take about 50 seconds.

---

## 7. Part C: the `parmana-core` API on your computer

### What it is and why

The policy and signing side, run locally. It registers connectors and decides what is allowed. It needs a database and at least one caller key.

### C1. Start the database

Docker Desktop must be running.

```powershell
cd D:\last\parmana-core
docker compose up -d postgres
docker compose ps postgres
```

Expected last line: `Up ... (healthy)` with port `127.0.0.1:55432->5432/tcp`.

The database user, password and name come from `docker-compose.yml`: `parmana`, the password in `PARMANA_DB_PASSWORD` (its local default is set in `docker-compose.yml`), `parmana`. That password is a local default, not a production secret. Replace `<LOCAL_DB_PASSWORD>` in the next step with that value.

### C2. Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

In Notepad, replace the `DATABASE_URL=` line with:

```
DATABASE_URL=postgresql://parmana:<LOCAL_DB_PASSWORD>@127.0.0.1:55432/parmana
```

Save as UTF-8.

Why: the API refuses to start without `DATABASE_URL` (see `.env.example` line 120).

### C3. Start the API

```powershell
npm run dev
```

Output seen on 2026-10-29, in order:

- `injected env (0) from ..\..\.env`: a loader looks one level above the repo. It finds nothing there. This is harmless; the API reads `.env` in the working folder.
- A few JSON events: a HubSpot token date warning and a Slack warning. Both are optional connectors and do not block the API.
- `runtime_engine_constructed`, `policy_governance_integrity_check_passed`.
- `API running on http://:3000`.

Before a caller key is added, the API stopped with:

```
Error: No caller authentication keys are configured (PARMANA_API_KEYS is empty or unset). Refusing to start with no caller authentication.
```

This is intentional: the API is closed unless a caller key exists. Fixed in C4.

Check that it is up, from a second window:

```powershell
Invoke-WebRequest http://localhost:3000/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `{"status":"UP"}`.

### C4. Create caller keys

A caller is a person or service with a key. The API stores only the **hash** of each key, never the key.

**Generate a key** (run once per caller):

```powershell
$raw = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
$hash = node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $raw
Write-Host "RAW KEY (save privately): $raw"
Write-Host "HASH: $hash"
```

- The raw key is the password. Keep it private. It is printed once.
- The hash goes into `.env`.

**Put the entries in `.env`.** One line, `PARMANA_API_KEYS`, containing a JSON array. Each entry:

| Field | Meaning |
| --- | --- |
| `callerId` | A name, for the audit trail |
| `keyHash` | 64 lowercase hex characters, the SHA-256 of the raw key |
| `allowedCapabilities` | `["*"]` for all |
| `credentialHolderType` | `USER` for a person |
| `stepUpPublicKey` | Required for a `USER` who approves changes. A PEM Ed25519 public key |

Keep the line in single quotes, because it contains JSON.

Two callers were created:
- `local-proposer`: proposes changes. Raw key from the first generate. Its raw key was pasted in chat, so treat it as exposed.
- `local-approver`: approves changes. Raw key generated separately. It must be a different entry from the proposer. A caller cannot approve its own change.

**Problems met while writing the key line**, with the fixes:
- The first hash was copied from the wrong run, so it did not match the raw key. The fix was to generate a new key, and to check the match with the block in section 10 (T-9).
- A first attempt to replace the line with a regex left the proposer line in place, and added nothing for the approver. The check showed two `PARMANA_API_KEYS=` lines. The fix was to remove every line that starts with `PARMANA_API_KEYS=` and write one new line (T-10).

### C5. Create the approver's step-up keys

```powershell
node -e "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('keys/approver-stepup.private.pem',privateKey.export({type:'pkcs8',format:'pem'}));require('fs').writeFileSync('keys/approver-stepup.public.pem',publicKey.export({type:'spki',format:'pem'}))"
Get-ChildItem keys\approver-stepup*
```

Why: an approval is valid only with a signature from this key. The public half is stored on the approver's `.env` entry. The API verifies the signature with it.

Check `git status` in `parmana-core`. `keys\` is expected to be ignored. Confirm before committing.

### C6. Put the approver entry in `.env`

Run after C4 and C5, with `$ahash` set from the approver generate step:

```powershell
$pub = (Get-Content keys\approver-stepup.public.pem -Raw).Trim() -replace "`r?`n", '\n'
$entries = '[{"callerId":"local-proposer","keyHash":"<PROPOSER_HASH>","allowedCapabilities":["*"],"credentialHolderType":"USER"},{"callerId":"local-approver","keyHash":"' + $ahash + '","allowedCapabilities":["*"],"credentialHolderType":"USER","stepUpPublicKey":"' + $pub + '"}]'
$kept = Get-Content .env | Where-Object { $_ -notmatch '^PARMANA_API_KEYS=' }
($kept + ("PARMANA_API_KEYS='" + $entries + "'")) | Set-Content .env -Encoding ascii
Select-String -Path .env -Pattern "^PARMANA_API_KEYS=" | ForEach-Object { $_.Line.Substring(0, 60) }
```

Replace `<PROPOSER_HASH>` with the proposer hash (in this session it was `40ec9c92...b7a6`). Expected: one `PARMANA_API_KEYS=` line.

Restart the API after any change to `.env`: press Ctrl+C in its window, then `npm run dev`.

### C7. Check a raw key against its hash

```powershell
$hash = node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $key
$line = (Select-String -Path .env -Pattern "keyHash").Line
if ($line -match $hash) { "MATCH" } else { "NO MATCH" }
```

`$key` must be set in the same window. Check with `if ($key) { "key is set" } else { "key is EMPTY" }`. Only `MATCH` means the key is correct.

---

## 8. Part D: registering `parmana-connect` as a connector

### What it is and why

`parmana-core` must know which endpoint serves `httpbin:get`. The registration is a **change**, and it follows two steps by two different people:

1. **Propose:** a human caller sends `action: "register"`. The change is `PENDING_APPROVAL`. Nothing is live.
2. **Approve:** a different human caller approves, with a step-up signature for that exact change ID. Only then does the registration become `active`.

The rules are in `packages/api/src/routes/external-connectors.ts`. The endpoint must be `https` with a public domain name. `localhost` and IP addresses are refused.

### D1. Propose

```powershell
$key = Read-Host "Paste your PROPOSER raw key"
$body = '{"action":"register","capability":"httpbin:get","endpointUrl":"https://parmana-connect.onrender.com","policy":"connector-capability","allowedParameters":[],"timeoutMs":10000,"reason":"Register parmana-connect test endpoint for httpbin:get"}'
try {
  $r = Invoke-WebRequest http://localhost:3000/external-connectors/changes -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $key"} -Body $body -UseBasicParsing
  "Status: $($r.StatusCode)"
  "Body: $($r.Content)"
} catch {
  "Error status: $($_.Exception.Response.StatusCode.value__)"
  "Error body: $($_.ErrorDetails.Message)"
}
```

Expected: `Status: 201` and a body containing `"changeId"` and `"status":"PENDING_APPROVAL"`.

This session's result:
- `changeId`: `a03974db-e207-4961-97d0-0647de802707`
- `endpointUrl`: stored as `https://parmana-connect.onrender.com/` (trailing slash added)
- `proposedBy`: `local-proposer`

Field meanings: `capability` is `namespace:verb`. `policy` must be a policy name in `policies/`. `allowedParameters` lists parameter names the connector may receive, and `[]` means none. `timeoutMs` is between 1000 and 30000.

### D2. Approve

The approval needs a step-up envelope, signed by the approver's private key, for this change ID and the action `approve`. The envelope expires after 120 seconds, so sign and send in one block.

```powershell
$akey = Read-Host "Paste the APPROVER raw key"
$changeId = "a03974db-e207-4961-97d0-0647de802707"
$out = npx tsx scripts/sign-policy-change-step-up.ts --private-key-file keys\approver-stepup.private.pem --key-id approver-stepup --pending-policy-change-id $changeId --action approve
$envelope = $out | Where-Object { $_ -like '{"payload"*' }
$abody = '{"stepUpAuthorization":' + $envelope + '}'
try {
  $r = Invoke-WebRequest "http://localhost:3000/external-connectors/changes/$changeId/approve" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $akey"} -Body $abody -UseBasicParsing
  "Status: $($r.StatusCode)"
  "Body: $($r.Content)"
} catch {
  "Error status: $($_.Exception.Response.StatusCode.value__)"
  "Error body: $($_.ErrorDetails.Message)"
}
```

Expected: `Status: 200`, `"status":"APPROVED"`, `"resolvedBy":"local-approver"`.

The check order on the server: caller authentication; a human caller; the change exists; the proposer is not the approver; the step-up envelope is valid (signature, expiry, change ID and action match, nonce unused). The first failing check decides the response.

### D3. Confirm the registration is active

```powershell
$r = Invoke-WebRequest http://localhost:3000/external-connectors -Headers @{Authorization="Bearer $akey"} -UseBasicParsing
$r.Content
```

The output lists every registration, including old test entries from earlier in the database. The entry to look for:

```
"registrationId":"a03974db-e207-4961-97d0-0647de802707","capability":"httpbin:get","endpointUrl":"https://parmana-connect.onrender.com/","policy":"connector-capability", ... "status":"active"
```

### D4. Why the end-to-end run is blocked

`parmana-core` decides with the policy `connector-capability`, version `1.1.0`. Its rules (`policies/connector-capability/1.1.0/policy.json`) are:

- `allow-crm-read`: `crm:read` with `humanApproved` true is approved.
- `allow-payments-refund-within-threshold`: `payments:refund` up to 5000.
- `block-crm-delete`, `block-payments-refund-above-threshold`: rejected.
- `reject-default`: everything else is rejected.

So `httpbin:get` is rejected by `reject-default`, even though it is registered. Fixing that needs a policy change: a new rule for `httpbin:get`, proposed and approved through the policy change flow (`docs/runbooks/POLICY-CHANGE-APPROVAL.md`), with its own step-up signatures. That is not done.

Routes that do exist for this: `POST /policies/pending-changes`, `POST /policies/pending-changes/<ID>/approve`, `POST /policies/pending-changes/<ID>/reject`. They were not used in this session.

---

## 9. Part E: the signed-request test

### What it is and why

The test signs a request as `parmana-core` would, and sends it to the service. It proves the service side, without needing the policy step.

### E1. Local

```powershell
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Result on 2026-10-29: `"success": true`, `"status": 200`. The upstream response showed `Host: httpbin.org` and the test `Authorization` header.

### E2. Public (Render)

```powershell
$env:PARMANA_SERVICE_URL = "https://parmana-connect.onrender.com"
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

First attempt: `Refused or failed: Execution System returned HTTP 401`. The bearer token in `.env` did not match Render's `PARMANA_SERVICE_BEARER_TOKEN`.

Second attempt, after the token on Render was corrected: `"success": true`, `"status": 200`, with `origin` showing Render's outgoing address.

What this proves: the public service verifies the signature, expiry and nonce, and calls the upstream. What it does not prove: that `parmana-core` made the decision. The script signs the request itself.

---

## 10. Troubleshooting index

Each entry: the symptom as shown, the cause, and the fix. Use the ID to find the matching section.

| ID | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| T-1 | `PARMANA_SERVICE_BEARER_TOKEN is required` with `.env` present | `Set-Content -Encoding utf8` wrote a byte-order mark | Rewrite `.env` with `-Encoding ascii` (A7) |
| T-2 | `fetch failed` from the signed-request script | Service not running | Start it with A8 first |
| T-3 | `Invoke-WebRequest: parameter 'SkipHttpErrorCheck' not found` | Windows PowerShell 5.1 | Use `try`/`catch` (A10) |
| T-4 | `git pull` stops: "untracked working tree files would be overwritten" | A copy of the same file exists untracked | Move the copy aside, pull, delete the copy |
| T-5 | `git am` fails: "does not exist in index" | Patch written for another repository | Stop. Do not force it. Write the change for the correct repository |
| T-6 | Render: "No open ports detected on 0.0.0.0" | Service bound to `127.0.0.1` | Set `PARMANA_SERVICE_HOST=0.0.0.0` (B2, PR #13) |
| T-7 | Render: `401` from the signed request | `PARMANA_SERVICE_BEARER_TOKEN` on Render does not match `.env` | Copy the value from `.env` into Render, redeploy (B2) |
| T-8 | Render health check fails, restarts | Health path `/healthz`, which the service does not serve | Clear the field (B1) |
| T-9 | `NO MATCH` on the key check | The raw key you typed is not the one that produced the hash in `.env` | Generate a new key and hash, update `.env`, restart the API (C4, C7) |
| T-10 | `.env` has two `PARMANA_API_KEYS=` lines, or the approver is missing | A regex replace did not match | Remove every `PARMANA_API_KEYS=` line, write one (C6) |
| T-11 | `No caller authentication keys are configured` at API start | `PARMANA_API_KEYS` empty | Add the key entries (C4) |
| T-12 | `Unable to connect to the remote server` (health) | API not running. It stops when its window closes or Ctrl+C is pressed | Run `npm run dev` again (C3) |
| T-13 | Empty error output from a request | Nothing listening on the port | Same as T-12 |
| T-14 | `401 {"error":"authentication required"}` on the proposal | `$key` empty, or the key does not match the hash | Run `if ($key)`; then run the match check (C7) |
| T-15 | `400 action must be "register" or "revoke"` | `$body` empty in this window | Set `$body` again (D1) |
| T-16 | `$body` empty after a window restart | PowerShell variables do not survive a new window | Set `$key`, `$body`, `$ahash` again |
| T-17 | Proposal output empty | `Select-Object -ExpandProperty Content` printed nothing | Use the `$r = ...` form with `"Status: ..."` (D1) |
| T-18 | `Error status:` and `Error body:` are blank | Connection failed, so there is no response | Check health (C3) |
| T-19 | Render build log shows the repo is not selectable | Render cannot read `parmana-connect` | Credentials → Configure in GitHub (B1) |
| T-20 | `claude remote-control`: "must be logged in" | No claude.ai login | `claude auth login` |
| T-21 | Computer-folder tool lists no folders | That tool lists only Mac or Linux folders | Run the commands yourself on Windows |
| T-22 | `prettier --write` changes many unrelated lines | The file already failed the formatting check | Revert, and apply only the intended edits |
| T-23 | Stop hook says there are uncommitted or untracked files | Work left in the tree | Commit on a new branch from `main`, push, open a PR (after approval) |
| T-24 | Branch delete refused by the permission system | Blocked as a destructive git action | Delete the branch in the GitHub web interface |
| T-25 | Policy rejects `httpbin:get` | `reject-default`: no rule for that capability | Policy change, see D4 (not done) |
| T-26 | `injected env (0) from ..\..\.env` at API start | A loader looks above the repo | Harmless. Nothing to fix |

---

## 11. Current state

| Area | State |
| --- | --- |
| `parmana-connect` code | `main` includes PRs #9 to #14. The host setting is merged |
| Local service | Works. A signed request returns 200 |
| Render service | Live at `https://parmana-connect.onrender.com`. Unsigned request returns 401. Signed request returned 200 on the second attempt |
| Local `parmana-core` database | Running in Docker, healthy |
| Local `parmana-core` API | Running on port 3000 when started with `npm run dev`. Health UP |
| Caller keys | `local-proposer` and `local-approver` exist. Proposer raw key was pasted in chat, so treat it as exposed |
| Registration | `httpbin:get` → `https://parmana-connect.onrender.com/`, status `active` |
| Policy for `httpbin:get` | Not present. Action would be rejected |
| End-to-end through `parmana-core` | Not done |

Known limits:

- Free Render tier sleeps after about 15 minutes idle. The first request is slow.
- `PARMANA_NONCE_STORE=memory` protects only one running instance from replays. Use `postgres` before running more than one.
- The test key in `keys\parmana-public.pem` is not Parmana's real key. A real deployment needs the operator's public key.
- The upstream is `httpbin.org`, a public echo service. Never put a real credential in `HTTPBIN_TOKEN`.
- Both approver and proposer are the same person here. The check that a different caller approves is enforced, but this test does not show a real two-person review.
- Documentation gap: `docs/SETUP.md` and `docs/EXECUTION-SERVICE.md` do not describe `PARMANA_SERVICE_HOST`.

---

## 12. What is left

| # | Item | Who | Notes |
| --- | --- | --- | --- |
| 1 | Open the PR for `docs/process-record-update` (commit `34110a3`) | You, with a yes from you | The record's section 10 row 10 |
| 2 | Fix the Prettier warning on `docs/PROCESS-RECORD.md` | Me, with a yes | The new table row is long |
| 3 | Regenerate the proposer key. Its raw key was shown in chat | You | Then update `PARMANA_API_KEYS`, restart the API. Local only, but treat as exposed |
| 4 | Decide on the policy rule for `httpbin:get` | You | Needs the policy change flow with two humans and step-up signatures |
| 5 | Run the end-to-end test through `parmana-core` `/execute` | You, with me | Depends on item 4 |
| 6 | Add `PARMANA_SERVICE_HOST` to `docs/SETUP.md` and `docs/EXECUTION-SERVICE.md` | Me, with a yes | A docs PR |
| 7 | Replace the test public key with the Parmana operator's public key | You, from the operator | Public key only |
| 8 | Switch `PARMANA_NONCE_STORE` to `postgres` before more than one instance | You and me | Needs a shared database |
| 9 | Register with the real `parmana-core` deployment, not the local API | You | Needs a human caller key on that deployment |
| 10 | Decide whether to pay for Render, to avoid the sleep | You | Free tier sleeps |
| 11 | Check Dependabot alert #5 is closed | You | `https://github.com/pavancharak/parmana-core/security/dependabot/5` |
| 12 | Delete the empty fork branch `claude/parmana-core-385-note` in `pavancharak/integrations` (optional) | You | No changes in it |
| 13 | Rotate `default.private.pem` when you choose (new key pair created 2026-10-29) | You | Old public key kept in `default.public.pem.bak` |

---

## 13. Commands quick reference

```powershell
# Database
cd D:\last\parmana-core
docker compose up -d postgres
docker compose ps postgres

# API
npm run dev
Invoke-WebRequest http://localhost:3000/health -UseBasicParsing | Select-Object -ExpandProperty Content

# Connector service, local
cd D:\last\parmana-connect
node --env-file=.env dist/main.js
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem

# Connector service, Render
$env:PARMANA_SERVICE_URL = "https://parmana-connect.onrender.com"
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Before any commit:

```powershell
git status --short
```

`.env`, `keys\` and `*.pem` must not appear in the output.
