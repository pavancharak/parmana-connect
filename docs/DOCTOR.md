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

## Settings reference

Every setting `doctor` reads, and what it does. Settings marked *service* are read by the execution service too. *Doctor* settings are read only by `doctor`, and only compare values.

| Setting | Used by | Required | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PARMANA_SERVICE_BEARER_TOKEN` | service | yes | none | Shared secret that parmana-core sends. At least 32 characters, and at least 8 different characters. |
| `PARMANA_POLICY_DIR` | service | yes | none | A folder that exists. The service does not read policy files from it. |
| `PARMANA_PUBLIC_KEY_FILE` | service | yes | none | Path to Parmana's Ed25519 public key, in PEM. Never a private key. |
| `PARMANA_CONNECTOR_MANIFEST` | service | yes | none | Path to the connector manifest (JSON or YAML). Its `https` base URL is checked by the loader. |
| *upstream credential* | service | yes | none | The environment variable named by the manifest's `secretRef`. Its value is never printed. |
| `PARMANA_RELEASE_AUDIENCE` | service | for releases | unset | The endpoint URL registered in parmana-core. Must be `https`. Unset, every release is refused with 503. |
| `PARMANA_NONCE_STORE` | service | no | `postgres` | `postgres` for shared deployments, `memory` for one local instance. |
| `PARMANA_DATABASE_URL` | service | with `postgres` | none | The replay database. Contains a password: never share it. |
| `PARMANA_SERVICE_PORT` | service | no | `8080` | Port, 1 to 65535. |
| `PARMANA_SERVICE_HOST` | service | no | `127.0.0.1` | Address to bind. Use `0.0.0.0` on a hosted service. |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | service | no | `10000` | Time limit for a connector call, 100 to 120000 ms. |
| `PARMANA_EXPECTED_KEY_FINGERPRINT` | service and doctor | no | unset | Pins the key. When set, the service refuses to start on a mismatch. |
| `PARMANA_EXPECTED_AUDIENCE` | service and doctor | no | unset | Pins the audience. When set, the service refuses to start unless `PARMANA_RELEASE_AUDIENCE` equals it. |
| `PARMANA_CORE_URL` | doctor (`--online`) | for online checks | unset | parmana-core's base URL, for the key and clock comparison. Must be `https`. |
| `PARMANA_CORE_KEY_ID` | doctor (`--online`) | no | `default` | The key ID to fetch from parmana-core. |

Other `PARMANA_` names are read by the MCP server or the tests. `doctor` accepts them without a warning. Any other `PARMANA_` name is reported as a probable typo.

## Troubleshooting

- **`cannot reach parmana-core from Node.js (error …)`.** PowerShell or a browser can reach the URL, but Node cannot. The code in the message says why. Common codes:
  - `ENOTFOUND`: the host name does not resolve. Check `PARMANA_CORE_URL` for a typo.
  - `UND_ERR_CONNECT_TIMEOUT` or `ETIMEDOUT`: the connection is blocked or slow. Check a proxy or firewall.
  - `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `SELF_SIGNED_CERT_IN_CHAIN`: a certificate Node does not trust, often added by a corporate proxy. Node uses its own certificate store, so the proxy's root certificate must be made available to Node.
- **The output does not match this document.** Your `dist/` folder is old. Run `git pull origin doctor-command`, `npm ci`, and `npm run build` again.
- **`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after the results.** The build predates the fix that sets `process.exitCode`. Rebuild.
- **`Missing script: "doctor"`.** You are on a branch or `main` without the doctor command. Check out the branch that has it.

## Maintaining doctor

- **A new check.** Add it in `src/doctor.ts` (offline) or `src/doctor-online.ts` (online). Give it a test in `tests/doctor.test.ts` or `tests/doctor-online.test.ts`. Add its row to the table in this file and a line to the README.
- **A new `PARMANA_` setting.** Add it to `KNOWN_SETTINGS` in `src/doctor.ts`, or `doctor` will report it as a typo. Add it to the settings reference above.
- **Messages.** Name the setting, never its value. Never print a URL that contains a password. Report database errors by code only.
- **Before pushing.** Run `npm run typecheck` and `npm test`, and the secret scan described below.

## Secret scanning

CI runs gitleaks (version 8.28.0) on every pull request. It scans each commit from the base branch to the tip, not only the tip. A secret that was removed in a later commit still fails the check, because it remains in the history of the pull request.

Run the same check locally before you push:

```bash
go install github.com/zricethezav/gitleaks/v8@v8.28.0
gitleaks detect --source . --log-opts="origin/main..HEAD" --redact --no-banner --exit-code 1
```

Exit code `0` means clean. Output is redacted; use `--report-format json --report-path report.json` to see the rule, file and line.

Two findings have already happened in this repository:
- A connection string with a password in a test fixture.
- A fixed hex string assigned to a variable named `TOKEN`, which matches the generic API key rule.

To avoid both:
- Do not write `scheme://user:password@host` anywhere, even in tests. The test needs only the host.
- Generate test secrets at run time, for example with `crypto.randomBytes`, rather than writing them as literals.
- Do not add an allowlist entry unless the value is a documented, reviewed false positive. If you add one, keep it narrow: one exact value per entry, with a comment.

If a finding is in an earlier commit of a pull request, fix it by squashing the pull request's commits into one clean commit and force-pushing with a lease. Get the owner's agreement first, because it rewrites a shared branch.
