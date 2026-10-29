# Execution service

The execution service is the receiving side of a Parmana authorization. `parmana-core` sends an approved request to it, and it runs one connector only if that request is authorized.

It is a library, `createExecutionService` in `src/execution-service.ts`. It has no command-line entry point or configuration loader yet.

## Request flow

`parmana-core`'s `HttpExecutionSystem` sends `POST /execute` with a JSON body:

```json
{
  "businessTransactionId": "...",
  "action": "example:item-fetch",
  "target": "items/123",
  "parameters": { "itemId": "123" },
  "authorization": { "payload": { ... }, "signature": "...", "keyId": "...", "algorithm": "..." }
}
```

The service checks the following, in order. The first failure stops the request.

| Check                                                                                                                                                                                 | Failure response                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Request path is `POST /execute`                                                                                                                                                       | 404                                                 |
| `Authorization: Bearer <token>` matches, compared in constant time                                                                                                                    | 401 `unauthorized`                                  |
| Body is JSON within the size limit (256 KiB by default)                                                                                                                               | 400                                                 |
| `authorization` is present                                                                                                                                                            | 401 `authorization required`                        |
| Required fields are strings, and `parameters` is an object                                                                                                                            | 400                                                 |
| `EnvelopeVerifier.verify`: signature, expiry, TTL, and a single-use nonce                                                                                                             | 403 `authorization invalid`, with the failed checks |
| The hash of `businessTransactionId`, `action`, `target` and `parameters`, computed with `toExecutableContent` and `ExecutableContentHasher`, equals `payload.businessTransactionHash` | 403 `authorization invalid`                         |
| `payload.grantedCapability` equals `action`                                                                                                                                           | 403 `authorization does not cover this action`      |
| The connector accepts the request                                                                                                                                                     | 200, with the `ExecutionResult`                     |

Connector errors map to these responses:

- `unknown_capability` or `invalid_input`: 422
- `upstream_error` or `timeout`: 502
- anything else: 500

Responses report the connector's error code only. They never include the credential or the upstream response body.

## Configuration

The caller passes these options to `createExecutionService`:

- `bearerToken`: the shared secret that `parmana-core` sends.
- `publicKey`: Parmana's public key, a Node `KeyObject`. The service never reads a key from a request.
- `connector`: a `GenericConnector` from `src/connector.ts`.
- `resolveCredential`: a function that returns the upstream secret. It is called once per request and its value is never logged.
- `credentialId`: the name of the credential reference, used in the credential handle.
- `nonceStore`: optional. The default is `MemoryNonceStore`.
- `timeoutMs` and `maxBodyBytes`: optional.

## Running it

The program is `src/main.ts`, started with `npm start` after `npm run build`. It reads these environment variables and refuses to start if a required one is missing or invalid. The error names the variable, never its value.

| Variable                       | Required        | Meaning                                                           |
| ------------------------------ | --------------- | ----------------------------------------------------------------- |
| `PARMANA_SERVICE_BEARER_TOKEN` | yes             | Shared secret that `parmana-core` sends. At least 32 characters.  |
| `PARMANA_PUBLIC_KEY_FILE`      | yes             | Path to Parmana's Ed25519 public key, in PEM.                     |
| `PARMANA_CONNECTOR_MANIFEST`   | yes             | Path to the connector manifest (JSON or YAML).                    |
| `<secretRef>`                  | yes             | The upstream secret. Its name is the `secretRef` in the manifest. |
| `PARMANA_POLICY_DIR`           | yes             | Any existing directory. The crypto bootstrap requires it.         |
| `PARMANA_NONCE_STORE`          | no              | `postgres` (default) or `memory`.                                 |
| `PARMANA_DATABASE_URL`         | with `postgres` | Connection string for the nonce database.                         |
| `PARMANA_SERVICE_PORT`         | no              | Default 8080.                                                     |
| `PARMANA_CONNECTOR_TIMEOUT_MS` | no              | Default 10000.                                                    |

### Replay protection

With `postgres`, every instance records each used nonce in the `parmana_connect_nonces` table, and a repeated nonce is refused whichever instance receives it. Create the table once, before the first start, with `npm run migrate` and `PARMANA_DATABASE_URL` set.

With `memory`, replay protection lives in one process. A restart, or a second instance, accepts an approval that was already used. Use it only for local development, and say so explicitly.

### Startup

```bash
npm run build
npm run migrate
npm start
```

## Dependencies

The service depends on four published packages, all at version 0.1.0 on npm:

| Package                      | Used for                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `@parmana/envelope-verifier` | Checking the signature, expiry, TTL and nonce of an authorization                       |
| `@parmana/crypto`            | Computing the transaction hash, through `ExecutableContentHasher` and `CryptoBootstrap` |
| `@parmana/shared`            | `toExecutableContent`, the shared content mapping that the gateway uses                 |
| `@parmana/execution-system`  | The request and response types that `parmana-core` sends                                |

Install with `npm ci` from the lock file. The lock file records the published versions only, with no local paths.

If `node_modules/@parmana` contains symlinks into another checkout, the tests run against that checkout, not the published packages. Delete `node_modules` and reinstall. This happened once during the switch from local links to published versions, and the tests passed against the local code until it was fixed. To check, run `node -p "require(./node_modules/@parmana/shared/package.json).version"`. It should print `0.1.0`.

## Tests

- `tests/execution-service.test.ts` signs real authorizations with `AuthorizationSigner` and calls the service over HTTP. It covers a valid request, a missing or wrong bearer token, a missing authorization, tampered parameters, a replay, an authorization for a different action, a signature from another key, and connector input that fails its schema.
- `tests/e2e-parmana-core.test.ts` sends requests with `parmana-core`'s own `HttpExecutionSystem` and signs them with its `AuthorizationSigner`. It covers an approved action, changed parameters, a replay, and a wrong bearer token.

Run `npx vitest run`. At the last run, with `PARMANA_TEST_DATABASE_URL` set to a local PostgreSQL 16 database, there were 107 tests in ten files, and all passed. Without that variable, the 5 PostgreSQL tests in `tests/postgres-nonce-store.test.ts` are skipped and the other 102 pass.

## Known gaps

- **Replay protection depends on the store.** With the default `postgres` store it holds across restarts and instances. With `memory` it does not.
- **Expiry has no test in this repository.** The envelope verifier's own tests cover it.
- **Policy is not re-evaluated.** The service trusts the signed approval, as the protocol intends. Parmana's own policy decision is the only policy check.
- **Startup** reads its configuration from the environment, as described above. It has not been run against a live `parmana-core` deployment yet.
- **Development links** are gone. The four `@parmana/*` dependencies are published 0.1.0 versions.

## Publishing status of the core packages

All four core packages are on npm at 0.1.0: `@parmana/shared`, `@parmana/crypto`, `@parmana/envelope-verifier` and `@parmana/execution-system`.

The four core packages are TypeScript internals of the Parmana server, published so this service can depend on them. The Python SDK (`parmana`) already covers client use and offline verification, and `parmana-verifier` on PyPI checks trust records.

A Python receiving service would need a port of the envelope verifier, the HTTP client, and the crypto and shared types. That is about one to two weeks of work, and ML-DSA-65 support in Python is uncertain. It is only worth doing if a Python team has to run the receiving side.
