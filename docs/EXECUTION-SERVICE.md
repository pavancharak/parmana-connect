# Execution service

The execution service is the receiving side of a Parmana authorization. `parmana-core` sends an approved request to it, and it runs one connector only if that request is authorized.

It is a library, `createExecutionService` in `src/execution-service.ts`. It has no command-line entry point or configuration loader yet.

## Request flow

`parmana-core`'s `HttpExecutionSystem` sends `POST /execute` with a JSON body:

```json
{
  "businessTransactionId": "...",
  "action": "hubspot:deal-fetch",
  "target": "crm/deals/123",
  "parameters": { "dealId": "123" },
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

The process also needs `PARMANA_POLICY_DIR` set. The crypto bootstrap refuses to start without it. Any existing directory works, because the service does not read policies.

## Tests

- `tests/execution-service.test.ts` signs real authorizations with `AuthorizationSigner` and calls the service over HTTP. It covers a valid request, a missing or wrong bearer token, a missing authorization, tampered parameters, a replay, an authorization for a different action, a signature from another key, and connector input that fails its schema.
- `tests/e2e-parmana-core.test.ts` sends requests with `parmana-core`'s own `HttpExecutionSystem` and signs them with its `AuthorizationSigner`. It covers an approved action, changed parameters, a replay, and a wrong bearer token.

Run `npx vitest run`. At the last run there were 59 tests in four files, and all passed.

## Known gaps

- **Replay memory is in process.** A restart or a second instance accepts an approval that was already used. A shared nonce store is needed before running more than one instance.
- **Expiry has no test in this repository.** The envelope verifier's own tests cover it.
- **Policy is not re-evaluated.** The service trusts the signed approval, as the protocol intends. Parmana's own policy decision is the only policy check.
- **No entry point or configuration loader.** Nothing starts the server or reads the bearer token, the public key or the credential from the environment yet.
- **Development links.** `package.json` links four `@parmana/*` packages with `file:` paths into a sibling `parmana-core` checkout. Replace them with published versions before merging.

## Publishing status of the core packages

`@parmana/shared`, `@parmana/crypto` and `@parmana/envelope-verifier` 0.1.0 are on npm. `@parmana/execution-system` 0.1.0 was published but is waiting for approval on npm's website. Until it is approved, the registry shows the placeholder `0.0.0-stage`.

## Why there is no Python version

The four core packages are TypeScript internals of the Parmana server, published so this service can depend on them. The Python SDK (`parmana`) already covers client use and offline verification, and `parmana-verifier` on PyPI checks trust records.

A Python receiving service would need a port of the envelope verifier, the HTTP client, and the crypto and shared types. That is about one to two weeks of work, and ML-DSA-65 support in Python is uncertain. It is only worth doing if a Python team has to run the receiving side.
