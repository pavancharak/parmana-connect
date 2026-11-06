# Connector release test: what was done, why, and the commands

**Scope:** parmana-connect (the connector service) released to by a local parmana-core (the decision and signing service), through a public HTTPS tunnel, calling httpbin.org with a read-only capability `httpbin:get`.

**Result:** the full release path ran and was verified. A request approved by a human approver was released by Parmana, executed by the connector, and recorded as a verified Execution Trust Record. The run was on a local Parmana in test mode, with in-memory storage.

---

## 1. Summary of outcomes

| Question | Answer | Evidence |
|---|---|---|
| Does the connector verify releases? | Yes, in the self-signed harness (10 of 10 cases as expected) | `exec-test/harness.mjs` |
| Does the connector accept parmana-core's real signatures? | Yes | Execution succeeded with parmana-core's `default` key |
| Does Parmana refuse a request with no approval? | Yes, in the sandbox copy (`POLICY_DENIED`) | sandbox check, section 5 |
| Did the release reach the connector and run the call? | Yes, `HTTP 200`, upstream status 200 | release response |
| Is the trust record verified? | Yes, `VERIFIED` with a receipt | release response |

Not covered: a production Parmana deployment, and the negative case on the Windows machine.

---

## 2. What the project is (from reading the code and README)

- **parmana-connect**: a Node.js service with one route, `POST /execute`. It accepts a release signed by parmana-core, checks it, runs the manifest's HTTP call, and answers.
- **parmana-core**: the decision service. It checks the policy, requires a human approval, signs the decision, and releases approved actions to a registered connector endpoint.
- **Rule**: a connector endpoint must be a public `https` host. `localhost` and IP addresses are refused, which is why a tunnel was needed.

Key facts confirmed from the code:
- `PR #36` (refuse a `read` capability that uses a method other than `GET`) was merged on 2026-11-05. The README I read first was out of date on this point.
- The connector's `PARMANA_RELEASE_ONLY` defaults to `false`. Set it to `true` to refuse the bearer-token route.
- The nonce store defaults to `postgres`. Memory is used only when asked for.

---

## 3. Steps, in order, with the reason for each

### 3.1 Read the documentation and config

**Why:** before testing, establish what the service does and what the defaults are.

- Read `README.md`, `docs/API.md` and `src/config.ts` on `main`.
- Confirmed the defaults above.

### 3.2 Build and test parmana-connect

**Why:** confirm the code compiles and the existing suite passes before testing anything new.

```bash
cd parmana-connect
npm ci
npm run build
npm test
```

Result: 166 passed, 7 skipped. The skipped tests are the PostgreSQL replay tests, which need `PARMANA_TEST_DATABASE_URL`.

### 3.3 Check the read/write method rules

**Why:** these are the rules you asked about (read, write, execute). Load sample manifests through the real loader and check each method.

Result:

| effect | method | result |
|---|---|---|
| read | GET | accepted |
| read | POST, PUT, PATCH, DELETE | refused: "a read capability must use GET" |
| write | GET | refused: "a GET capability cannot be a write" |
| write | POST, PUT, PATCH, DELETE | accepted when inputs are declared |
| write | any, no inputs declared | refused: "a write capability must declare its input" |

### 3.4 Self-signed harness (verifier logic only)

**Why:** the real parmana-core was not reachable at first. A harness generated its own Ed25519 key, signed releases, and ran the built service locally. This tests the verifier logic against the documented contract. It does not test parmana-core's real signing.

Files: `scratchpad/exec-test/harness.mjs` (run with `node harness.mjs`).

Results, after correcting three of my own wrong expectations:

| # | Case | Result |
|---|---|---|
| 1 | Valid signed release | 200, ran |
| 2 | Same release again | same stored answer, not run again |
| 3 | Parameters changed after signing | 403, signature does not verify |
| 4 | Signed with another key | 403, signature does not verify |
| 5 | Wrong audience | 403 |
| 6 | Expired | 403 |
| 7 | Capability not in manifest | 403 |
| 8 | No release, no bearer token | 403, release-only refusal |
| 9 | Bearer token route, release-only | 403 |
| 10 | Body that is neither release nor authorization | 403, release-only refusal |

Two of my expectations were wrong at first:
- Test 2 expected a 403 with "already executed". The code returns the first stored answer, which matches the README. The API doc's wording is the part that differs.
- Tests 8 and 10 expected 401 and 400. With `PARMANA_RELEASE_ONLY=true`, the refusal comes before body checks, so the status is 403.

### 3.5 Public Parmana sandbox: attempted, not usable

**Why:** the docs describe a public sandbox with a demo key. Using it would have tested the real parmana-core.

Steps:
- `curl https://parmana-sandbox.vercel.app/health` returned `UP`. `/api` returned 401.
- The docs say the demo key is shown in the playground. The playground routes returned 401 and the root page is API-only.
- The production guide says the production deployment has no public or demo key.

Conclusion: no usable demo key. I did not search other sites for keys.

### 3.6 Local parmana-core (sandbox copy)

**Why:** the quickstart runs parmana-core locally with its real signing, which is the closest test available without a deployment.

Commands (in the scratchpad copy, not your repo):
```bash
cp -r /home/user/parmana-core core
cp .env.example .env
npm ci --ignore-scripts          # skipped native build scripts
npm run build
npm rebuild re2                   # native module needed at runtime
npx tsx scripts/generate-keypair.ts --algorithm ed25519 --key-id default
npm run generate:gateway-keys
npx tsx scripts/generate-approver-key.ts --approver-id local-test-approver --key-id local-test-approver-key-1 --out-dir ~/.parmana
```

Issues found along the way:
- `npm ci --ignore-scripts` skipped the native build of `re2`, so the server crashed. Fix: `npm rebuild re2`.
- The approver script does not create its output folder. Fix: `mkdir ~/.parmana` first.
- The server refuses to start with the kill switch on unless a `kill-switch-probe` key exists. The quickstart doesn't mention this. Fix: set `KILL_SWITCH_ENABLED=false` for the test.

### 3.7 Test server: start command

Environment used:
```bash
NODE_ENV=test PARMANA_STORAGE=memory KILL_SWITCH_ENABLED=false \
  PARMANA_API_KEYS='[...]' \
  PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE=$HOME/.parmana/local-test-approver__local-test-approver-key-1.public.pem \
  npm run dev
```

Why each variable:
- `NODE_ENV=test` enables the test-only fixture connector and the test approver trust.
- `PARMANA_STORAGE=memory` avoids needing a database. State is lost on restart.
- `KILL_SWITCH_ENABLED=false` avoids the probe-key requirement and the database.
- `PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE` makes the server trust the local approver key without the maker-checker flow. This is test mode only.

### 3.8 Tunnel and connector

**Why:** Parmana refuses localhost. The connector needs a public HTTPS URL that Parmana can release to.

Attempt 1 (sandbox): localtunnel. The egress proxy returned `405` for the tunnel client's plain `GET` requests (the proxy log showed "non-CONNECT request"). Upgrading axios did not fix it. I did not bypass the proxy. Result: blocked.

Attempt 2 (your machine): `cloudflared`.
- `winget install --id Cloudflare.cloudflared` failed once with exit code 1603, then succeeded on a second run.
- `cloudflared tunnel --url http://127.0.0.1:8099` printed `https://tribune-corpus-submissions-beans.trycloudflare.com`.

Connector commands (PowerShell, in `D:\last\parmana-connect`):
```powershell
$env:PARMANA_SERVICE_BEARER_TOKEN = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$env:PARMANA_PUBLIC_KEY_FILE = "D:\last\parmana-core\keys\default.public.pem"
$env:PARMANA_CONNECTOR_MANIFEST = "$PWD\manifests\httpbin.json"
$env:PARMANA_POLICY_DIR = $PWD
$env:PARMANA_RELEASE_AUDIENCE = "https://tribune-corpus-submissions-beans.trycloudflare.com/execute"
$env:PARMANA_NONCE_STORE = "memory"
$env:PARMANA_RELEASE_ONLY = "true"
$env:PARMANA_SERVICE_PORT = "8099"
$env:PARMANA_SERVICE_HOST = "127.0.0.1"
$env:HTTPBIN_TOKEN = "test-upstream-token"
node dist\main.js
```

Why each variable:
- `PARMANA_PUBLIC_KEY_FILE` must be parmana-core's real public key, so the connector trusts its signatures.
- `PARMANA_RELEASE_AUDIENCE` must match the endpoint URL registered in Parmana, exactly.
- `PARMANA_RELEASE_ONLY=true` refuses the bearer-token route, so only signed releases run.
- `HTTPBIN_TOKEN` is a test value, not a real credential.

Health checks passed locally and through the tunnel: `{"status":"UP"}` both times.

### 3.9 Governance setup on the test server

**Why:** a release needs an approved policy and an active connector registration. Each requires a second person's approval (maker-checker). Test mode lets one machine play both roles with different keys, which is not a real two-person control. The record therefore shows two different callers, but it's the same operator.

**Keys created** (raw keys shown once and not written to disk by the script):
```powershell
npx tsx scripts/generate-api-key.ts --caller-id proposer-local --credential-holder-type USER
npx tsx scripts/generate-api-key.ts --caller-id approver-local --credential-holder-type USER --generate-step-up-key
npx tsx scripts/generate-api-key.ts --caller-id agent-local --credential-holder-type SERVICE --allowed-capabilities httpbin:get
```

- proposer: proposes changes
- approver: approves changes, with a step-up key (Ed25519) that signs each approval
- agent: calls `/execute` for `httpbin:get` only

The approver's step-up private key was saved to `$HOME\.parmana\approver-step-up.private.pem`. Its public half is in `PARMANA_API_KEYS`.

**Policy:** `policies\httpbin-read\1.0.0\policy.json`. One signal, `humanApproved`, bound to the target. Rule: approve only with a verified human approval, reject otherwise.

Why a new policy: no existing policy fits `httpbin:get`. `connector-capability` binds a payment amount to `parameters.amount`, which this capability doesn't have. The policy passed the repo's reference policy test (25 of 25) in the sandbox copy.

**Server restart:**
```powershell
. .\start-test-env.ps1
npm run dev
```
The script sets the variables (`NODE_ENV`, `PARMANA_STORAGE`, `KILL_SWITCH_ENABLED`, `PARMANA_API_KEYS`, `POLICY_CHANGE_CHECKERS`, `PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE`) in the same window. Using `. ` (dot-sourcing) keeps them in the window.

`POLICY_CHANGE_CHECKERS = {"httpbin-read":["approver-local"]}` says only `approver-local` may approve changes to that policy.

**Propose and approve the policy:**
```powershell
$body = @{ reason = "..."; proposedContent = (Get-Content -Raw -Encoding UTF8 $policyPath | ConvertFrom-Json) } | ConvertTo-Json -Depth 20
$prop = Invoke-RestMethod -Method Post -Uri "$url/policies/httpbin-read/1.0.0/pending-changes" -Headers @{Authorization="Bearer $PROP"} -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

$cid = $prop.pendingPolicyChangeId
$su = npx tsx scripts/sign-policy-change-step-up.ts --private-key-file "$HOME\.parmana\approver-step-up.private.pem" --key-id approver-local --pending-policy-change-id $cid --action approve | Where-Object { $_ -like '{*' }
Invoke-RestMethod -Method Post -Uri "$url/policies/pending-changes/$cid/approve" -Headers @{Authorization="Bearer $APPR"} -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes('{"stepUpAuthorization":' + $su + '}'))
```

Why a step-up signature: the approver signs the exact change ID and action, with a short expiry, so an approval can't be replayed for another change.

**Register and approve the connector:**
```powershell
$reg = @{ action="register"; capability="httpbin:get"; endpointUrl="https://<tunnel>/execute"; policy="httpbin-read"; allowedParameters=@(); timeoutMs=10000; reason="..." } | ConvertTo-Json
$r = Invoke-RestMethod -Method Post -Uri "$url/external-connectors/changes" -Headers @{Authorization="Bearer $PROP"} -ContentType "application/json" -Body ([System.Text.Encoding]::UTF8.GetBytes($reg))
# step-up signature and approve, as above, using $r.changeId
```

Why: Parmana binds the capability to one endpoint URL and one policy. The endpoint address is checked as public https at proposal and again at approval.

Result: status `APPROVED`, and the connector list showed the entry as active.

### 3.10 Release

**Why:** this is the actual test. The agent calls `/execute` with a request that carries a human approval for this target.

1. Sign the approval with the test approver key:
```powershell
npx tsx scripts/sign-approval.ts --private-key-file "$HOME\.parmana\local-test-approver__local-test-approver-key-1.private.pem" --approver-id local-test-approver --key-id local-test-approver-key-1 --capability httpbin:get --resource-id httpbin --out approval.json
```
The approval is usable once and expires after 15 minutes.

2. Build the request with `build-tx.mjs` (Node), which puts the approval into `signals.approvalArtifact`:
```powershell
node build-tx.mjs approval.json tx.json
```
Why Node and not PowerShell: `ConvertFrom-Json` and `ConvertTo-Json` can change a signed object's shape. Node writes the exact JSON.

3. Send it with the agent key:
```powershell
curl.exe -s -w "`nHTTP %{http_code}`n" -X POST "$url/execute" -H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" --data-binary "@tx.json"
```

**Result:** `HTTP 200`.
- `status: COMPLETED`, connector `success: true`, upstream status 200.
- `verifications: VERIFIED`, with a receipt.
- The `default` key signed the decision and the trust record.
- The policy's governance anchor was `VERIFIED`.

---

## 4. Problems met and how each was fixed

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find path ...scratchpad\core` in PowerShell | The path was a Linux sandbox path | Use the Windows path `D:\last\parmana-core` |
| `Refusing to overwrite existing keys` | Keys already existed | Kept them. `--force` would have broken existing signatures |
| `mkdir -p` error in PowerShell | PowerShell has no `-p` | Not needed; the folder existed |
| `The term 'cloudflared' is not recognized` | Not installed | `winget install`, then a new window |
| `Cannot find module dist\main.js` | Wrong folder | Run from `parmana-connect` |
| `winget` exit code 1603 | Windows Installer error | Re-ran; succeeded |
| Quickstart server exited: "no kill-switch-probe entry" | Kill switch was on | `KILL_SWITCH_ENABLED=false` |
| `PARMANA_API_KEYS is not valid JSON` | The variable was not set in that window | Set it in the same window, or use the script |
| `authentication required` (401) on every key, even matching ones | An older server was still answering on port 3000 | Found by starting a second server on port 3100 and testing it there |
| `Internal Server Error` on approval | The policy file had a UTF-8 byte-order mark from `Set-Content -Encoding UTF8` | Rewrote the file without BOM |
| `authentication required` on the connector request | PowerShell variable names are case-insensitive: `$prop` overwrote `$PROP` | Renamed the response variable; reloaded the key |
| `Malformed JSON body` | The signature variable was empty because the previous step failed | Fixed the step before it |
| `Cannot find module build-tx.mjs` | The helper was never created | Created it with `WriteAllText` (no BOM) |
| `curl: option --data-binary: error` | `tx.json` didn't exist yet | Created by `build-tx.mjs` first |

---

## 5. The negative case (sandbox only)

Sent the same request with no approval (`humanApproved: false`, no artifact). Parmana returned:
```
{"error":"Execution rejected: httpbin:get rejected because no verified human approval was provided.","code":"POLICY_DENIED"}
```
HTTP 403. Nothing was dispatched. This was run only in the sandbox copy, not on your machine.

---

## 6. Security findings

1. **Upstream credential echoed into the trust record.** httpbin.org echoes request headers, so the response stored in the Execution Trust Record contains `Authorization: Bearer test-upstream-token`. The value is a test string, but the pattern is the one the README warns about. For a real upstream, use a credential that is safe to appear in records, or make sure response headers are filtered before storage.
2. **Single operator in test mode.** The two-person control (proposer and approver) was enforced by different API keys on one machine. The record claims two people. That is a test artifact, not a control.
3. **Test-only trust.** `PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE` trusts the local approver key without maker-checker. It works only with `NODE_ENV=test`.
4. **Tunnel exposure.** The connector was reachable from the internet during the test, for about 40 minutes, with the bearer token and `PARMANA_RELEASE_ONLY=true`. Anyone who had the tunnel URL could have sent a request that failed signature checks. Nothing else was exposed.
5. **Key files.** Raw keys were shown in the generator output and in the terminal. Do not reuse them. The step-up private key and the approver's API key must stay on the approver's machine.

---

## 7. Documentation gaps found

- The quickstart doesn't mention the kill-switch probe requirement.
- The docs and the code disagree on the replay response: docs say "already executed", the code returns the first answer.
- `npm ci --ignore-scripts` (or any install that skips scripts) leaves `re2` unbuilt, and the server then crashes at startup with no clear message.
- The approver key script doesn't create its output folder.
- The README's status section was out of date on PR #36.

---

## 8. Cleanup and what to keep

- Stop the connector, the tunnel, and the Parmana server on port 3100. The old server on port 3000 was still running; close its window too.
- Keep `D:\last\parmana-core\keys\` and `$HOME\.parmana\` private. They contain private keys.
- The raw API keys printed during setup are not recoverable. Generate new ones for any further test.

---

## 9. Files

| Path | Purpose |
|---|---|
| `D:\last\parmana-connect\manifests\httpbin.json` | the connector manifest |
| `D:\last\parmana-core\policies\httpbin-read\1.0.0\policy.json` | the test policy (no BOM) |
| `D:\last\parmana-core\start-test-env.ps1` | test settings, dot-sourced into the server window |
| `D:\last\parmana-core\build-tx.mjs` | builds the signed request body |
| `D:\last\parmana-core\approval.json`, `tx.json` | the approval and request from the test run |
| `D:\last\parmana-core\keys\default.public.pem` | parmana-core's public key, trusted by the connector |
| `$HOME\.parmana\approver-step-up.private.pem` | the approver's step-up private key (keep private) |
| `scratchpad\exec-test\harness.mjs` | the self-signed harness (sandbox) |
