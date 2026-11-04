# Doctor: how to run it and what to do with the result

`doctor` checks that the execution service is set up correctly before you start it, and before partners rely on it. It reads the same settings as the service. It prints each check as PASS, WARN or FAIL, with a fix for each problem. It never prints a secret value.

## When to run it

- Before the first start of the service on a machine.
- After changing `.env`, or after pulling a new version of this repository.
- After a key rotation, or when parmana-core's key or audience changes.
- When a release is refused and you do not know why.
- Before you tell a partner the endpoint is ready.

## How to run it

Install and build once:

```powershell
npm ci
npm run build
```

Offline checks (no network, no database):

```powershell
node --env-file-if-exists=.env dist/doctor-main.js
```

Online checks (also compares the key and the clock with parmana-core, and checks the database):

```powershell
node --env-file-if-exists=.env dist/doctor-main.js --online
```

`--env-file-if-exists=.env` reads your `.env` file. The service does not read `.env` when started with `npm start`, so the settings must be present in the shell or in `.env` for doctor to see them the same way.

Check the result:

```powershell
echo $LASTEXITCODE
```

- `0`: no check failed. Warnings may remain. Read them.
- `1`: at least one check failed. Do not start the service until it is fixed.

## Reading the output

- **PASS:** the setting is correct.
- **WARN:** the service works, but something needs attention. Each warning says what to do. Warnings do not block the service.
- **FAIL:** the service would refuse to run, or would refuse every release. Fix it before starting the service.

The last line counts failures and warnings. A line starting with `fix:` says what to change.

## Each check, and what to do

| Check | Fails when | What to do |
| --- | --- | --- |
| Node.js | Node is older than 24 | Install Node.js 24 or later, then run `npm ci` again. |
| PARMANA_SERVICE_BEARER_TOKEN | Missing, shorter than 32 characters, or uses fewer than 8 different characters | Generate a new token with `openssl rand -hex 32` and set it in `.env`. Parmana-core must send the same value. |
| PARMANA_POLICY_DIR | Missing, or the folder does not exist | Set it to a folder that exists. The service needs the folder, not files in it. Policies are held in parmana-core. |
| PARMANA_PUBLIC_KEY_FILE | Missing, unreadable, not a key, not Ed25519, a private key, or not matching the pinned fingerprint | See "Fixing a key mismatch" below. If the file holds a private key, treat that private key as compromised. |
| PARMANA_CONNECTOR_MANIFEST | Missing, unreadable, invalid, or its credential variable is not set | Correct the manifest at the path shown, and set the credential variable it names. |
| PARMANA_RELEASE_AUDIENCE | Missing (every release is refused), not https, or not equal to the pinned audience | Set it to the exact URL registered in parmana-core, including the path, character for character. |
| PARMANA_NONCE_STORE | Set to something other than `postgres` or `memory` | Use `postgres` for any shared deployment. `memory` is for one local instance only. |
| PARMANA_DATABASE_URL | Missing, when the store is `postgres` | Set it to the replay database. Never share this line; it holds a password. |
| port and timeout | A port or timeout value is out of range | Correct the value shown. |
| (unknown setting) | A `PARMANA_` name that no component reads | Rename it to the suggested name, or remove it. The service ignores it otherwise. |
| clock (offline) | Always a warning, because the clock cannot be checked offline | Use `--online`, or check the clock by hand. |
| parmana-core | `PARMANA_CORE_URL` missing, not https, or the core cannot be reached | Set `PARMANA_CORE_URL` to parmana-core's address. If it fails only from Node, check for a proxy or a certificate Node does not trust. The message gives Node's error code. |
| parmana-core key | Your key file is not the key parmana-core publishes | See "Fixing a key mismatch" below. |
| clock (online) | This machine is more than 30 seconds from parmana-core | Turn on automatic time sync (Windows Time or NTP), then run again. |
| database | Cannot connect, the nonce table is missing (warning), or INSERT and DELETE are not granted | Check `PARMANA_DATABASE_URL`, and grant INSERT and DELETE on `parmana_connect_nonces` to that user. The error code is shown; the connection string is not. |

## Fixing a key mismatch

The message "the key in PARMANA_PUBLIC_KEY_FILE is not the key parmana-core publishes" means the file and parmana-core disagree. Do not copy a key from parmana-core into your file to make the check pass.

1. Note both fingerprints from the message.
2. Ask the Parmana operator which key is current, and get its fingerprint.
3. Confirm that fingerprint through a second channel, such as a phone call to a known number. Do not confirm it by replying to the same message that sent the key.
4. If your file is the wrong key, replace it with the confirmed key.
5. If parmana-core's key changed, confirm the new fingerprint before you accept it. A changed key is a rotation, and you should know it happened.
6. Set `PARMANA_EXPECTED_KEY_FINGERPRINT` to the confirmed fingerprint. From then on the service refuses to start if the key changes.
7. Run doctor with `--online` again. The key check should pass.

## Pinning the key and the audience

Until you pin them, doctor warns that the key and the audience were not compared. Pin them once you have confirmed the values:

- `PARMANA_EXPECTED_KEY_FINGERPRINT`: the `sha256:` fingerprint you confirmed.
- `PARMANA_EXPECTED_AUDIENCE`: the URL registered in parmana-core, exactly.

With these set, the service refuses to start on a mismatch. That is intended. A legitimate key rotation or audience change will stop the service until you update the pinned value after confirming the change.

## What doctor does not check

- Whether the database user can do more than insert and delete rows.
- The clock against a time source you trust. It is compared with parmana-core's clock only.
- Whether the connector is registered in parmana-core. That happens in the registration flow.
- Whether the policies in parmana-core allow the actions you want. Check those in parmana-core.

## Handling the output safely

- The fingerprint is a public value. It is safe to share when you ask for help.
- Do not paste `.env`. It holds the bearer token, the upstream credential and the database password.
- Doctor does not print secret values, but a shared screenshot of `.env` would.
