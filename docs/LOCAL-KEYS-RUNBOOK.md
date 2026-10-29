# Local caller and approval keys: storage, rotation and troubleshooting

Applies to `D:\last\parmana-core` on a Windows computer, for the local API on port 3000. Date written: 2026-10-29.

This runbook covers the keys used to call the local `parmana-core` API and to approve changes. It doesn't cover production keys. Production keys are created and held by the operator, and never follow these steps.

---

## 1. The rule for keys

- A raw key is a password. It is shown once, when it is generated. Keep it in a file on your computer, and never paste it into chat, a commit, a ticket or a screenshot.
- The API stores only the SHA-256 hash of each raw key, in `.env`, in the `PARMANA_API_KEYS` line. The hash can't be used to log in.
- Keys are stored in `D:\last\parmana-core\keys\`, which git ignores. Run `git status` before any commit, and check that no key file is listed.

---

## 2. What is stored where

| File | What it is | Used by |
| --- | --- | --- |
| `keys\proposer-raw.txt` | Raw key for `local-proposer` (proposes changes and calls `/execute`) | Every proposal, and `/execute` |
| `keys\approver-raw.txt` | Raw key for `local-approver` (approves changes) | Every approval |
| `keys\approver-stepup.private.pem` | Private key that signs the approver's step-up. Never shared | `scripts/sign-policy-change-step-up.ts` |
| `keys\approver-stepup.public.pem` | Public half. Stored as `stepUpPublicKey` for `local-approver` in `.env` | The API checks the step-up with it |
| `keys\local-issuer.private.pem` | Private key of the approval issuer `local-issuer`. Signs approval artifacts | `scripts/sign-approval.ts` |
| `keys\local-issuer.public.pem` | Public half. The API trusts it through an approved issuer change | The API |
| `keys\httpbin-approval.json` | One approval artifact. Valid 15 minutes, usable once. Regenerate for each request | Sent in `signals.approvalArtifact` |
| `keys\default.private.pem` | Parmana's signing key. Signs authorizations and releases | `parmana-core`, and the signed-request test |
| `keys\default.public.pem` | Public half of the above | `parmana-connect`, as `keys\parmana-public.pem` |
| `.env`, `PARMANA_API_KEYS` line | The hashes of the caller keys, and the approver's `stepUpPublicKey` | The API, at startup |

Run this to list the key files, without showing any content:

```powershell
Get-ChildItem keys\*-raw.txt, keys\*.pem | Select-Object Name, Length
```

Each `*-raw.txt` file should be 43 bytes long.

---

## 3. Reading a key from its file

Never type a key into a command. Load it from the file:

```powershell
$key = Get-Content keys\proposer-raw.txt
$akey = Get-Content keys\approver-raw.txt
```

If a file is empty or missing, see troubleshooting T-3 and T-4.

---

## 4. Creating a key, and saving it to its file

Use this only for a new key. The raw key is written to a file and never printed:

```powershell
cd D:\last\parmana-core
$raw = node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
Set-Content -Path keys\proposer-raw.txt -Value $raw -Encoding ascii
$hash = node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" $raw
```

Only the hash is shown, if you print it. Put it into `.env` (section 5).

For the approver, use the same block with `keys\approver-raw.txt`. Its hash goes into the `local-approver` entry.

If you need to save a key you already have, type it once, at the prompt:

```powershell
Read-Host "Type the APPROVER raw key" | Set-Content -Path keys\approver-raw.txt -Encoding ascii
```

Wait for the prompt to return before running another command. Pressing Ctrl+C here leaves no file.

---

## 5. Putting a hash into `.env`

`.env` must have exactly one `PARMANA_API_KEYS=` line. It holds all the callers in one JSON array, in single quotes. To replace the proposer's hash:

```powershell
(Get-Content .env -Raw) -replace '"callerId":"local-proposer","keyHash":"[0-9a-f]{64}"', ('"callerId":"local-proposer","keyHash":"' + $hash + '"') | Set-Content .env -Encoding ascii
Select-String -Path .env -Pattern $hash -Quiet
```

The last line must print `True`. Use the same pattern with `local-approver` to replace the approver's hash.

To check there is only one `PARMANA_API_KEYS=` line:

```powershell
Select-String -Path .env -Pattern "^PARMANA_API_KEYS=" | ForEach-Object { $_.Line.Substring(0, 60) }
```

Expected: one line. If there are two, see T-6.

---

## 6. Restart the API after any change

The API reads `.env` only at startup. In its window, press Ctrl+C, then run:

```powershell
npm run dev
```

Wait for `API running on http://:3000`. Check it's up:

```powershell
Invoke-WebRequest http://localhost:3000/health -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: `{"status":"UP"}`.

---

## 7. Rotating a key

Rotation replaces a key whose raw value may be exposed. Do it in this order:

1. Create the new key into its file (section 4).
2. Put its hash into `.env` (section 5).
3. Restart the API (section 6).
4. Check the health endpoint.

The old key stops working when the API restarts with the new hash. Nothing else needs changing, because every request loads its key from the file.

---

## 8. Signing an approval for an action

Approvals for `httpbin:get` are signed by `local-issuer`. An approval is valid for 15 minutes and usable once, so sign a new one for each request:

```powershell
npx tsx scripts/sign-approval.ts --private-key-file keys\local-issuer.private.pem --approver-id local-issuer --key-id local-issuer-key-1 --capability httpbin:get --resource-id httpbin --out keys\httpbin-approval.json
```

Expected: `Signed approval for httpbin:get on httpbin, expires ...`.

---

## 9. Troubleshooting

| ID | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| T-1 | `401 {"error":"authentication required"}` | The key is missing, empty, or doesn't match a hash | Check `$key` with `if ($key) {...}`, then run the match check (T-2) |
| T-2 | Match check prints `NO MATCH` | The raw key doesn't produce the hash in `.env` | Rotate the key (section 7) |
| T-3 | `Get-Content : Cannot find path ... raw.txt` | The key file was never created | Create it (section 4) |
| T-4 | `Get-Content` returns nothing, or the length is 0 | The file was created empty, often because a command was stopped at its prompt | Recreate it with `Read-Host`, and wait for the prompt to return |
| T-5 | `No caller authentication keys are configured` at API start | `PARMANA_API_KEYS` is empty | Add the entries (section 5) |
| T-6 | Two `PARMANA_API_KEYS=` lines, or a caller is missing | An earlier replacement didn't match | Remove every `PARMANA_API_KEYS=` line, and write one line with all callers |
| T-7 | `400 {"error":"action must be \"register\" or \"revoke\"."}` | `$body` is empty in this window | Set `$body` again |
| T-8 | `403 CHECKER_NOT_IN_SCOPE` on a policy approval | `POLICY_CHANGE_CHECKERS` doesn't list the checker for this policy | Add `POLICY_CHANGE_CHECKERS='{"<policy>":["local-approver"]}'` to `.env`, and restart |
| T-9 | `400 publicKeyPem must be an Ed25519 public key in PEM` | The PEM was turned into JSON wrongly | Build the body with `-join '\n'` on the file lines (see the approval-issuer proposal in the progress report) |
| T-10 | `API refuses to start: PARMANA_TEST_APPROVER_PUBLIC_KEY_FILE is set, but NODE_ENV is not test` | The test approver line is still in `.env` | Remove that line. The test approver works only with `NODE_ENV=test`, and that mode keeps no data between restarts |
| T-11 | Registration or policy lost after a restart | The API ran in test mode, which doesn't use Postgres | Run in normal mode (`Remove-Item Env:NODE_ENV`), then propose and approve again |
| T-12 | `404 CAPABILITY_NOT_BOUND` on `/policies/in-effect` | The capability's active registration is missing | Check the registration list, and register again if needed |
| T-13 | `502 EXECUTION_OUTCOME_UNKNOWN` from `/execute` | The release reached the endpoint but the endpoint failed or refused it | Check the endpoint's logs. Don't retry the same transaction. An endpoint at `https://host/` (no `/execute`) fails this way |
| T-14 | `Invoke-WebRequest : Unable to connect to the remote server` | The API isn't running | Start it (section 6) |
| T-15 | Blank error status and body | Nothing answered | Same as T-14 |

---

## 10. What not to do

- Don't paste a raw key into chat, a commit message, a ticket, or a screenshot.
- Don't leave a raw key in a file outside `keys\`.
- Don't use one key for both the proposer and the approver. A caller can't approve its own change, and the check exists for that reason.
- Don't use `NODE_ENV=test` for work you want to keep. It stores nothing between restarts.
- Don't run `git add` on `keys\` or `.env`.
