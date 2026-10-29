# Setup: run the execution service locally and on Render

This guide takes you from a fresh folder to a running execution service, first on your own Windows computer and then on Render's free tier. Each step says where to run it and what you should see.

Read `docs/EXECUTION-SERVICE.md` for what each setting does.

---

## Part 1: Run it on your computer (Windows, PowerShell)

### Step 1. Check Node.js

Run this in PowerShell:

```powershell
node -v
```

You must see `v24.` followed by a number. If you see anything else, install Node 24 before going on.

### Step 2. Go to the project folder and install

```powershell
cd D:\last\parmana-connect
npm ci
npm run build
```

You should see no errors at the end of `npm run build`.

### Step 3. Make the folders the service needs

```powershell
New-Item -ItemType Directory -Force keys, manifests, policies | Out-Null
```

### Step 4. Create the public key file

This creates the public key the service checks signatures with. It does not create a private key.

```powershell
node -e "const c=require('crypto');const {publicKey}=c.generateKeyPairSync('ed25519');require('fs').writeFileSync('keys/parmana-public.pem',publicKey.export({type:'spki',format:'pem'}))"
```

For a real Parmana deployment, replace `keys\parmana-public.pem` with the public key that the Parmana operator gives you. See Part 3.

### Step 5. Create the connector manifest

Create `manifests\httpbin.json`. This example calls `httpbin.org`, a public echo service, for testing only:

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

### Step 6. Write the `.env` file

This generates a new random bearer token and writes `.env`. The file uses ASCII encoding, because a byte-order mark breaks the first setting.

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

Keep `.env` private. It is git-ignored, so `git status` should not list it. Each time you run this step, you get a new token, so `parmana-core` must be updated with the new value.

### Step 7. Start the service

Keep this window open:

```powershell
node --env-file=.env dist/main.js
```

You should see `execution service listening on port 8080`.

### Step 8. Send a signed test request

Open a second PowerShell window in the same folder. Run this, using the private key from `parmana-core`:

```powershell
node --env-file=.env scripts\signed-request.mjs D:\last\parmana-core\keys\default.private.pem
```

A pass prints `"success": true` and `"status": 200`.

### Step 9 (optional). Check that the service rejects bad requests

```powershell
try {
  Invoke-WebRequest http://localhost:8080/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

A `401` means the bearer token check is working.

---

## Part 2: Deploy to Render (free tier)

### Before you start

- You need a Render account and a GitHub connection.
- Render must have access to the `pavancharak/parmana-connect` repository. In the **Credentials** dropdown on the new service page, choose **Configure in GitHub**, then add `parmana-connect` to the repository list.
- Free services sleep after 15 minutes without traffic. The first request after a sleep is slow.

### Step 1. Create the service

1. In Render, click **New → Web Service**.
2. Select `pavancharak/parmana-connect`.
3. Set these fields:
   - **Name:** `parmana-connect`
   - **Branch:** `main`
   - **Language:** Node
   - **Region:** any
   - **Build Command:** `npm ci && npm run build`
   - **Start Command:** `npm run start`
   - **Health Check Path:** `/health`. The service answers `GET /health` with `{"status":"UP"}`.

### Step 2. Choose the free plan

Under **Compute**, select **Free ($0 / month)**. Check the bottom of the page shows $0.

### Step 3. Add environment variables

Click **Add Environment Variable** for each line below. The key goes in the left box and the value in the right.

| Key                            | Value                                                              |
| ------------------------------ | ------------------------------------------------------------------ |
| `NODE_VERSION`                 | `24`                                                               |
| `PARMANA_SERVICE_PORT`         | `10000`                                                            |
| `PARMANA_SERVICE_HOST`         | `0.0.0.0`                                                          |
| `PARMANA_SERVICE_BEARER_TOKEN` | the value of `PARMANA_SERVICE_BEARER_TOKEN` from your local `.env` |
| `PARMANA_PUBLIC_KEY_FILE`      | `/etc/secrets/parmana-public.pem`                                  |
| `PARMANA_CONNECTOR_MANIFEST`   | `/etc/secrets/httpbin.json`                                        |
| `PARMANA_POLICY_DIR`           | `.`                                                                |
| `PARMANA_NONCE_STORE`          | `memory`                                                           |
| `HTTPBIN_TOKEN`                | `test-only-not-a-real-secret`                                      |
| `PARMANA_RELEASE_AUDIENCE`     | `https://parmana-connect.onrender.com/execute`                     |

Do not use **Add from .env**, because it uploads your whole local file.

### Step 4. Add the secret files

Under **Advanced → Secret Files**, click **Add Secret File** twice:

1. **Filename:** `parmana-public.pem`. **Contents:** the full text of `D:\last\parmana-connect\keys\parmana-public.pem`.
2. **Filename:** `httpbin.json`. **Contents:** the full text of `D:\last\parmana-connect\manifests\httpbin.json`.

Copy the contents from Notepad, select all, then paste into Render.

### Step 5. Deploy

Click **Deploy web service** and wait for the build log to show the service is live. If the build fails, copy the last 20 lines of the log.

### Step 6. Test

Replace `<your-service>` with the name Render gives you:

```powershell
try {
  Invoke-WebRequest https://<your-service>.onrender.com/execute -Method Post -ContentType "application/json" -Body "{}" -UseBasicParsing
} catch {
  $_.Exception.Response.StatusCode.value__
}
```

A `401` means the service is live on the internet.

---

## Part 3: Replace the test key with a real one

The `parmana-public.pem` you created in Part 1 is a test key. Real requests from a Parmana deployment are signed with that deployment's private key, so they fail against a test key.

1. Ask the Parmana operator for the public key that matches their signing key. It starts with `-----BEGIN PUBLIC KEY-----`. Ask only for the public key, never the private key.
2. Replace `keys\parmana-public.pem` on your computer with that file.
3. In Render, update the `parmana-public.pem` secret file with the same contents, then redeploy.

---

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `PARMANA_SERVICE_BEARER_TOKEN is required` | `.env` has a byte-order mark, or the variable is missing. Rewrite `.env` with Step 6, which uses ASCII encoding. |
| Error names `PARMANA_POLICY_DIR`           | The variable is missing from `.env`, or the folder it names does not exist. Run Part 1 Steps 3 and 6.            |
| `fetch failed` from the test script        | The service is not running. Start it with Step 7 in Part 1.                                                      |
| `401` from the test script                 | Expected for an empty request. The service is up.                                                                |
| Render build fails on `npm ci`             | Check that `package-lock.json` is in the repository.                                                             |
| Render marks the service unhealthy         | The health check path is set to `/healthz`, which the service does not serve. Set it to `/health`, as in Part 2 Step 1. |
| Render page is slow the first time         | Free services sleep. Wait a minute and try again.                                                                |
