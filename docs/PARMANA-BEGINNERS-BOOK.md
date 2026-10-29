# Parmana for beginners: a step-by-step book

Written for a developer who is new to Parmana. Use it as a guide: read the concepts first, then follow the parts in order. Every command shows what you should see. If you see something different, go to the troubleshooting list in Part 12.

This book describes the setup we used on Windows with PowerShell, on 2026-10-29. Some values in it are test values. Part 13 says which ones are not for production.

---

## Contents

- Part 1. What Parmana is, in plain words
- Part 2. The words you will meet (glossary)
- Part 3. What you need on your computer
- Part 4. Get the code
- Part 5. Start the database and the Parmana API
- Part 6. Create caller keys and put them in `.env`
- Part 7. Start the connector service (`parmana-connect`)
- Part 8. Create the public key and the connector manifest
- Part 9. Deploy the connector service to Render
- Part 10. Register a connector: propose, then approve
- Part 11. Make a request that Parmana allows
- Part 12. Troubleshooting index
- Part 13. What is for testing only, and what is not
- Part 14. Where to find things in the repositories
- Part 15. Checklist for your first working day

---

## Part 1. What Parmana is, in plain words

An AI agent (or a program) wants to do something in another system, such as "read a deal from a CRM" or "refund a payment". Parmana sits between them. Before the action runs, Parmana asks:

1. Is this action allowed by a **policy**?
2. Did a **person** approve this exact action on this exact target?
3. Is the request **signed** by the right keys, and is it still fresh?

If the answers are yes, Parmana signs a decision and releases the action to a **connector**. The connector is the code that talks to the other system. If the answers are no, Parmana refuses and says why.

Every decision is recorded in a **trust record**, signed by Parmana, so anyone can check it later.

Two repositories matter for a beginner:

- **`parmana-core`**: the policy engine, the API, the keys and the database. You run its API on your computer.
- **`parmana-connect`**: a small service that runs one connector. Here it calls `httpbin.org`, a public test service. You can run it on your computer, or deploy it.

---

## Part 2. The words you will meet (glossary)

| Word | Meaning |
| --- | --- |
| **Action** | What should happen, named `namespace:verb`, for example `httpbin:get`. |
| **Capability** | The same as an action, when it is registered as something that can be called. |
| **Target** | What the action applies to, such as an order id or `httpbin`. |
| **Policy** | A JSON file of rules that decides allow or reject for an action. Lives in `policies\<name>\<version>\policy.json`. |
| **Policy version** | A policy is changed by adding a new version, never by editing an approved one. |
| **Caller** | Whoever calls the API. Each caller has a **key**. |
| **Raw key** | The secret text a caller uses. It is shown once. Keep it private. |
| **Hash** | A fingerprint of a raw key. The API stores only the hash, in `.env`. |
| **Proposer** | The caller who proposes a change. |
| **Approver** | A different caller who approves it. The server refuses an approval from the proposer. |
| **Step-up signature** | An extra signature from the approver's own key, for one exact change. |
| **Approval artifact** | A signed statement by a trusted issuer that a person approved one action on one target. It is usable once and expires after 15 minutes. |
| **Approval issuer** | A trusted person or key that signs approval artifacts. Added through a proposal and an approval. |
| **Connector** | The code that performs the action in another system. |
| **Registration** | The fact that a capability is served by an HTTPS endpoint, and governed by a policy. |
| **Endpoint** | The URL of the connector service. For external connectors it must be the full execute URL, ending in `/execute`. |
| **Release** | Parmana's signed message to an endpoint, saying "run this, it was approved". |
| **Trust record** | Parmana's signed record of a decision and its evidence. |
| **Manifest** | A JSON file that describes one external system and its capabilities. |
| **`.env`** | A text file of settings the program reads at startup. It holds secrets. Never commit it. |
| **Health check** | `GET /health`. It answers `{"status":"UP"}` when the API is running. |

---

## Part 3. What you need on your computer

| Need | How to check | Expected |
| --- | --- | --- |
| Windows with PowerShell | Open PowerShell | A blue or dark window, prompt like `PS C:\Users\you>` |
| Node.js 24 | `node -v` | `v24.` and a number |
| Git | `git --version` | `git version 2.` and a number |
| Docker Desktop, running | `docker --version` | `Docker version` and a number. Docker Desktop must be open |
| A GitHub account with access to `pavancharak/parmana-core` and `pavancharak/parmana-connect` | Open both links in a browser | You see the code |

If `node -v` shows `v22` or lower, install Node 24 before going on. Old Node versions fail with `ERR_DLOPEN_FAILED` when a native module was built for another version.

---

## Part 4. Get the code

Make a folder for the work, then clone both repositories.

```powershell
New-Item -ItemType Directory -Force D:\last | Out-Null
cd D:\last
git clone https://github.com/pavancharak/parmana-core.git
git clone https://github.com/pavancharak/parmana-connect.git
```

Expected: each `git clone` ends with no error. You now have `D:\last\parmana-core` and `D:\last\parmana-connect`.

Install the packages for each:

```powershell
cd D:\last\parmana-core
npm install
cd D:\last\parmana-connect
npm ci
npm run build
```

Expected: no red error lines. `npm run build` in `parmana-connect` creates a folder named `dist`.

Rule for every session: before you commit, run `git status`. Never commit `.env`, anything in `keys\`, or any `*.pem` file.

---

## Part 5. Start the database and the Parmana API

Parmana's API stores approvals and registrations in a Postgres database, which runs in Docker.

### 5.1 Start the database

Open Docker Desktop and wait until it says it is running.

```powershell
cd D:\last\parmana-core
docker compose up -d postgres
docker compose ps postgres
```

Expected from the last command: a line with `Up ... (healthy)` and `127.0.0.1:55432->5432/tcp`. The first time it can take a minute.

Why: the API keeps its data here. The database user and password come from `docker-compose.yml`. The password `parmana-local` is a local default only.

### 5.2 Create the `.env` file for the API

```powershell
Copy-Item .env.example .env
notepad .env
```

In Notepad, find the line `DATABASE_URL=` and replace it with:

```
DATABASE_URL=postgresql://parmana:parmana-local@127.0.0.1:55432/parmana
```

Save the file and close Notepad.

Why: the API will not start without `DATABASE_URL`.

### 5.3 Start the API

```powershell
npm run dev
```

Expected output, in order, ends with:

```
API running on http://:3000
```

Keep this window open. The API runs here until you press Ctrl+C.

If it stops with `No caller authentication keys are configured`, that is expected until you complete Part 6.

### 5.4 Check the API is up

Open a second PowerShell window:

```powershell
Invoke-WebRequest http://localhost:3000/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `{"status":"UP"}`

Note: Windows PowerShell 5.1 has no `-SkipHttpErrorCheck` parameter. Use `try` and `catch` to read a status code, as shown in Part 12.

---

## Part 6. Create caller keys and put them in `.env`

Parmana will not start without at least one caller key. You need two callers for the approval flow: a **proposer** and an **approver**. A caller cannot approve its own change.

### 6.1 Create a key and save it to a file

The raw key goes into a file, and only the hash is printed. Do this for the proposer:

```powershell
cd D:\last\parmana-core
$raw = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
Set-Content -Path keys\proposer-raw.txt -Value $raw -Encoding ascii
$hash = node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $raw
Write-Host "PROPOSER HASH: $hash"
```

Expected: `PROPOSER HASH:` followed by 64 characters. The file `keys\proposer-raw.txt` now exists. Its length should be 43. Check it without showing it:

```powershell
(Get-Content keys\proposer-raw.txt -Raw).Length
```

Expected: `43`.

Repeat the same block for the approver, changing the file name to `keys\approver-raw.txt` and the variable names if you like. Write down the approver hash too.

### 6.2 Put the callers in `.env`

`.env` must have exactly one `PARMANA_API_KEYS=` line. It contains a JSON list of callers, in single quotes. Replace the two hashes below with yours:

```
PARMANA_API_KEYS='[{"callerId":"local-proposer","keyHash":"PROPOSER_HASH","allowedCapabilities":["*"],"credentialHolderType":"USER"},{"callerId":"local-approver","keyHash":"APPROVER_HASH","allowedCapabilities":["*"],"credentialHolderType":"USER","stepUpPublicKey":"PEM_TEXT_ON_ONE_LINE"}]'
```

The approver's `stepUpPublicKey` is a public key you create in Part 6.3.

Why one line: `.env` is read line by line. Two lines with the same name confuse the reader, so keep one.

### 6.3 Create the approver's step-up key pair

```powershell
node -e "const c=require('crypto');const {publicKey,privateKey}=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('keys/approver-stepup.private.pem',privateKey.export({type:'pkcs8',format:'pem'}));require('fs').writeFileSync('keys/approver-stepup.public.pem',publicKey.export({type:'spki',format:'pem'}))"
Get-ChildItem keys\approver-stepup*
```

Expected: two files, `approver-stepup.private.pem` (119 bytes) and `approver-stepup.public.pem` (113 bytes).

Why: approvals are signed. The private file signs, the public file is what the API checks with. Keep the private file private.

### 6.4 Restart the API

In the API window press Ctrl+C, then:

```powershell
npm run dev
```

Expected: `API running on http://:3000`. Check with `/health` as in 5.4.

### 6.5 Check a key against its hash

This confirms the file, the hash and `.env` agree. It prints only `MATCH` or `NO MATCH`:

```powershell
$key = Get-Content keys\proposer-raw.txt
$hash = node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $key
$line = (Select-String -Path .env -Pattern "local-proposer").Line
if ($line -match $hash) { "MATCH" } else { "NO MATCH" }
```

Expected: `MATCH`.

Full rules for keys, rotation and their errors are in `docs/LOCAL-KEYS-RUNBOOK.md` in `parmana-connect`.

---

## Part 7. Start the connector service on your computer

`parmana-connect` checks signed releases and runs the connector. You can test it on your computer before you deploy.

### 7.1 Create its `.env`

Open a new window:

```powershell
cd D:\last\parmana-connect
New-Item -ItemType Directory -Force keys, manifests, policies | Out-Null
```

Then create the public key file from the parmana-core default key. This is the key that verifies Parmana's signatures:

```powershell
Copy-Item D:\last\parmana-core\keys\default.public.pem D:\last\parmana-connect\keys\parmana-public.pem -Force
Get-Content keys\parmana-public.pem -TotalCount 1
```

Expected: `-----BEGIN PUBLIC KEY-----`.

Note: `default.public.pem` exists only after `parmana-core` has created its signing keys. If the file is missing, see troubleshooting T-7.

### 7.2 Create the connector manifest

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

Why: the manifest says what the connector can do. `httpbin:get` calls `https://httpbin.org/get`, a public test service.

### 7.3 Create `.env`

```powershell
$token = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
@"
PARMANA_SERVICE_BEARER_TOKEN=$token
PARMANA_PUBLIC_KEY_FILE=keys\parmana-public.pem
PARMANA_CONNECTOR_MANIFEST=manifests\httpbin.json
PARMANA_POLICY_DIR=policies
PARMANA_NONCE_STORE=memory
HTTPBIN_TOKEN=test-only-not-a-real-secret
PARMANA_RELEASE_AUDIENCE=https://parmana-connect.onrender.com/execute
"@ | Set-Content -Path .env -Encoding ascii
```

Why `-Encoding ascii`: `utf8` adds an invisible mark at the start of the file, which hides the first setting from the program.

### 7.4 Start the service

```powershell
node --env-file=.env dist/main.js
```

Expected: `execution service listening on port 8080`. Keep this window open.

### 7.5 Send a signed test request to it

In a second window, in `D:\last\parmana-connect`:

```powershell
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

Expected: `"success": true` and `"status": 200`. This signs a request with Parmana's private key and sends it to the service. It proves the service accepts Parmana's signatures.

---

## Part 8. What the connector needs from Render (optional now)

You only need Render when `parmana-core` must reach the connector over the internet. For a first session on your computer, skip to Part 10.

Render is a hosting site. The free plan sleeps after about 15 minutes idle. The first request after a sleep can take about 50 seconds.

Steps are in `docs/SETUP.md`, Part 2. The main points:

- Create a **Web Service** from `pavancharak/parmana-connect`, branch `main`.
- Build command: `npm ci && npm run build`. Start command: `npm run start`.
- Leave the health check path empty.
- Add these environment variables:

| Key | Value |
| --- | --- |
| `NODE_VERSION` | `24` |
| `PARMANA_SERVICE_PORT` | `10000` |
| `PARMANA_SERVICE_HOST` | `0.0.0.0` |
| `PARMANA_SERVICE_BEARER_TOKEN` | the same value as your local `.env` |
| `PARMANA_PUBLIC_KEY_FILE` | `/etc/secrets/parmana-public.pem` |
| `PARMANA_CONNECTOR_MANIFEST` | `/etc/secrets/httpbin.json` |
| `PARMANA_POLICY_DIR` | `.` |
| `PARMANA_NONCE_STORE` | `memory` |
| `HTTPBIN_TOKEN` | `test-only-not-a-real-secret` |
| `PARMANA_RELEASE_AUDIENCE` | `https://parmana-connect.onrender.com/execute` |

- Add two secret files: `parmana-public.pem` and `httpbin.json`, with their contents pasted from your local copies.

Expected in the logs: `execution service listening on port 10000`, and the service shows **Live**.

Check it is reachable:

```powershell
try {
  Invoke-WebRequest https://parmana-connect.onrender.com/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

Expected: `401`. A 401 means the service is up and refused a request with no signature.

---

## Part 9. Understand a registration before you make one

A registration says: "the capability `httpbin:get` is run by the endpoint `https://parmana-connect.onrender.com/execute`, and it is governed by the policy `httpbin-read`."

A registration is a change, and changes follow two rules:

1. A **proposer** sends the change. Nothing goes live.
2. An **approver** signs it with a step-up signature. Only then does it become active.

The endpoint must be `https` and use a public domain name. `localhost` is refused. The URL must be the full path to `/execute`. A URL ending in `/` fails with a 502 at release time (troubleshooting T-14).

A registration also needs a policy. A policy is a JSON file. The `httpbin-read` policy in this project says a read of `httpbin` is allowed only when an approval artifact for `httpbin` is attached.

---

## Part 10. Register a connector: propose, then approve

We will register `httpbin:get` under the policy `httpbin-read`. The policy exists in `policies\httpbin-read\1.0.0\policy.json`.

### 10.1 Propose the registration

In `D:\last\parmana-core`, in a new window, with the API running:

```powershell
$key = Get-Content keys\proposer-raw.txt
$body = '{"action":"register","capability":"httpbin:get","endpointUrl":"https://parmana-connect.onrender.com/execute","policy":"httpbin-read","allowedParameters":[],"timeoutMs":10000,"reason":"Register parmana-connect for httpbin:get"}'
try {
  $r = Invoke-WebRequest http://localhost:3000/external-connectors/changes -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $key"} -Body $body -UseBasicParsing
  "Status: $($r.StatusCode)"
  "Body: $($r.Content)"
} catch {
  "Error status: $($_.Exception.Response.StatusCode.value__)"
  "Error body: $($_.ErrorDetails.Message)"
}
```

Expected: `Status: 201`, with `"status":"PENDING_APPROVAL"` and a `changeId` (a long ID with dashes). Write the `changeId` down.

### 10.2 Approve it

The approver signs with the step-up key. The block reads the approver's key from its file and sends the approval. Replace `CHANGE_ID` with the `changeId` from 10.1:

```powershell
$akey = Get-Content keys\approver-raw.txt
$changeId = "CHANGE_ID"
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

Expected: `Status: 200`, with `"status":"APPROVED"` and `"resolvedBy":"local-approver"`.

Why the step-up envelope expires: it is valid for 120 seconds. Sign and send in one block, as above.

### 10.3 Check the registration is active

```powershell
$key = Get-Content keys\proposer-raw.txt
$r = Invoke-WebRequest http://localhost:3000/external-connectors -Headers @{Authorization="Bearer $key"} -UseBasicParsing
($r.Content -split '\{"registrationId"') | Where-Object { $_ -match 'httpbin:get' -and $_ -match '"status":"active"' }
```

Expected: one entry showing `"policy":"httpbin-read"` and `"status":"active"`. The list also shows old test entries from earlier. Ignore those.

---

## Part 11. Make a request that Parmana allows

A request to `/execute` needs five things:

1. A **policy** name and version, as returned by the policy lookup.
2. An **authority** and an **authorization**, which name who asks and why.
3. An **intent**: the action, target and parameters.
4. **Signals**: for this policy, `readApproved` set to `true`, plus the approval artifact.
5. The caller's key, in the `Authorization` header.

### 11.1 Check which policy applies

```powershell
$key = Get-Content keys\proposer-raw.txt
try {
  $r = Invoke-WebRequest "http://localhost:3000/policies/in-effect?capability=httpbin:get" -Headers @{Authorization="Bearer $key"} -UseBasicParsing
  "Status: $($r.StatusCode)"
  "Body: $($r.Content)"
} catch {
  "Error status: $($_.Exception.Response.StatusCode.value__)"
  "Error body: $($_.ErrorDetails.Message)"
}
```

Expected: `Status: 200`, with `"name":"httpbin-read"`.

### 11.2 Sign an approval artifact

The approval comes from a trusted approval issuer. In this project that is `local-issuer`, which an approver added through a change. Sign a new artifact each time, because it is usable once:

```powershell
npx tsx scripts/sign-approval.ts --private-key-file keys\local-issuer.private.pem --approver-id local-issuer --key-id local-issuer-key-1 --capability httpbin:get --resource-id httpbin --out keys\httpbin-approval.json
```

Expected: `Signed approval for httpbin:get on httpbin, expires ...` and `Written to keys\httpbin-approval.json`.

Why: `--resource-id httpbin` names the target. The policy only accepts an approval for the target in the request.

### 11.3 Send the request

```powershell
$key = Get-Content keys\proposer-raw.txt
$tx = [guid]::NewGuid().ToString()
$aid = [guid]::NewGuid().ToString()
$zid = [guid]::NewGuid().ToString()
$iid = [guid]::NewGuid().ToString()
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
$artifact = Get-Content keys\httpbin-approval.json -Raw
$body = '{"businessTransactionId":"' + $tx + '","metadata":{"businessTransactionId":"' + $tx + '"},"authority":{"authorityId":"' + $aid + '","authorityType":"SERVICE","principalId":"local-proposer","issuedAt":"' + $now + '"},"authorization":{"authorizationId":"' + $zid + '","authorityId":"' + $aid + '","purpose":"Test httpbin:get through parmana-core","issuedAt":"' + $now + '"},"intent":{"intentId":"' + $iid + '","authorizationId":"' + $zid + '","action":"httpbin:get","target":"httpbin","parameters":{},"createdAt":"' + $now + '"},"policy":{"name":"httpbin-read","version":"1.0.0","schemaVersion":"1.0.0"},"signals":{"readApproved":true,"approvalArtifact":' + $artifact + '}}'
try {
  $r = Invoke-WebRequest http://localhost:3000/execute -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $key"} -Body $body -UseBasicParsing
  "Status: $($r.StatusCode)"
  "Body: $($r.Content)"
} catch {
  "Error status: $($_.Exception.Response.StatusCode.value__)"
  "Error body: $($_.ErrorDetails.Message)"
}
```

Expected: `Status: 200`. In the body, look for:

- `"status":"COMPLETED"` under `executions`
- `"outcome":"APPROVED"` in the decision
- `"verifications":[{"status":"VERIFIED"...`

This means Parmana allowed the action, signed a record, and released it to the endpoint. The connector call to `httpbin.org` returned `200`. The `Authorization` header in the response shows the test value. That is expected.

What the 200 proves: policy, approval, signing and release all worked end to end.

### 11.4 Rules for every request

- A `businessTransactionId` is used once. Make a new one for every request. Reusing one gets `409`.
- Do not resend a `502 EXECUTION_OUTCOME_UNKNOWN`. The action may have run. Check the target system first, as the error message says.
- An approval artifact is usable once. Sign a new one for each request.

---

## Part 12. Troubleshooting index

Find the symptom, then go to the cause and fix.

| ID | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| T-1 | `Unable to connect to the remote server` | The API is not running | Start it, Part 5.3 |
| T-2 | Empty error status and body | Nothing answered | Same as T-1 |
| T-3 | `401 {"error":"authentication required"}` | The key is missing, empty or does not match | Part 6.5 |
| T-4 | `NO MATCH` on the key check | The key file and `.env` disagree | Rotate the key, Part 6.1 and 6.2, then restart |
| T-5 | `No caller authentication keys are configured` | `PARMANA_API_KEYS` is empty | Part 6.2 |
| T-6 | Two `PARMANA_API_KEYS=` lines in `.env` | A replacement did not match | Keep one line only |
| T-7 | `default.public.pem` is missing | parmana-core has not created its signing keys | Run its key setup, or ask whoever runs it |
| T-8 | `403 CHECKER_NOT_IN_SCOPE` on a policy approval | The checker is not in `POLICY_CHANGE_CHECKERS` | Add `POLICY_CHANGE_CHECKERS='{"<policy>":["local-approver"]}'` to `.env`, restart |
| T-9 | `400 action must be "register" or "revoke"` | `$body` is empty in this window | Set `$body` again |
| T-10 | `400 publicKeyPem must be an Ed25519 public key` | The PEM was written into JSON wrongly | Build the body with the PEM lines joined by `\n` |
| T-11 | `API refuses to start: PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE is set` | A test setting is in `.env` without test mode | Remove that line |
| T-12 | Registrations or approvals disappear after a restart | The API ran in test mode, which keeps no data | Run without `NODE_ENV=test`: `Remove-Item Env:NODE_ENV`, then `npm run dev` |
| T-13 | `404 CAPABILITY_NOT_BOUND` | No active registration for the capability | Part 10 |
| T-14 | `502 EXECUTION_OUTCOME_UNKNOWN` | The release reached the endpoint but failed | Check the endpoint's logs. The endpoint URL must end in `/execute`. Do not retry the same transaction |
| T-15 | `409` on `/execute` | The `businessTransactionId` was already used | Make a new one |
| T-16 | `Refused or failed: Execution System returned HTTP 401` | The bearer token in local `.env` differs from Render's | Make them match, then redeploy |
| T-17 | Render says `No open ports detected on 0.0.0.0` | The service listens on `127.0.0.1` | Set `PARMANA_SERVICE_HOST=0.0.0.0` on Render |
| T-18 | Render logs port 8080 | `PARMANA_SERVICE_PORT` is not set on Render | Set it to `10000` |
| T-19 | `Missing` keys after a `.env` rebuild | A rebuild created a new bearer token | Copy the new token to Render, or keep the old one |
| T-20 | `git status` lists `.env` or `keys\` | The ignore rules are missing | Stop. Do not commit. Check `.gitignore` |

To read a PowerShell error body on Windows PowerShell 5.1, use this pattern. It replaces the `-SkipHttpErrorCheck` option, which 5.1 does not have:

```powershell
try {
  Invoke-WebRequest <url> -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  "Status: $($_.Exception.Response.StatusCode.value__)"
  "Body: $($_.ErrorDetails.Message)"
}
```

---

## Part 13. What is for testing only, and what is not

For testing only, in this book:

- `keys\parmana-public.pem` on `parmana-connect` is a copy of a local key. Real Parmana deployments have their own keys, and their operator gives you the public key.
- `local-issuer` is a local approval issuer. A real deployment has issuers that the operator approves.
- `local-proposer` and `local-approver` are both your keys. Real use needs two different people.
- `PARMANA_NONCE_STORE=memory` only protects one running instance from a replayed request.
- `httpbin.org` is a public echo service. Never give it a real credential.
- The Render free plan sleeps when idle.
- `NODE_ENV=test` keeps no data between restarts. Do not use it to keep work.

Before real use, the operator must provide: its public key, real approval issuers, a shared database for the nonce store, and a paid hosting plan if the service must stay awake.

---

## Part 14. Where to find things

| What | Where |
| --- | --- |
| The API's routes and checks | `parmana-core\packages\api\src\routes\` |
| The policy rules | `parmana-core\policies\<name>\<version>\policy.json` |
| The release protocol | `parmana-connect\src\external-release.ts`, and `docs\adr\ADR-0013-Generic-External-Connector.md` in `parmana-core` |
| The connector service | `parmana-connect\src\execution-service.ts` |
| Setup for Render | `parmana-connect\docs\SETUP.md` |
| Local keys | `parmana-connect\docs\LOCAL-KEYS-RUNBOOK.md` |
| The progress report | `parmana-connect\docs\PROGRESS-REPORT.md` |
| The full history | `parmana-connect\docs\PROCESS-RECORD.md` and `docs\FULL-PROCESS-GUIDE.md` |
| Policy change runbook | `parmana-core\docs\runbooks\POLICY-CHANGE-APPROVAL.md` |

---

## Part 15. Checklist for your first working day

Work through these in order. Tick each one before you go on.

1. `node -v` shows `v24`.
2. Docker Desktop is running, and `docker compose ps postgres` shows `healthy`.
3. `parmana-core` `.env` has `DATABASE_URL` and one `PARMANA_API_KEYS=` line.
4. `npm run dev` prints `API running on http://:3000`.
5. `/health` returns `{"status":"UP"}`.
6. `keys\proposer-raw.txt` has length `43`, and the match check prints `MATCH`.
7. `parmana-connect` `.env` has all its variables. `node --env-file=.env dist/main.js` prints `listening on port 8080`.
8. The signed-request test prints `"status": 200`.
9. You can list the active registration for `httpbin:get`.
10. You can make the `/execute` request, and it returns `200` with `COMPLETED`.

When all ten are ticked, you have run Parmana from request to signed record. Read Part 13 again before you use anything for real.
