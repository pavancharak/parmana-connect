# HTTP API: `POST /execute`

The service has one route that does work, `POST /execute`, and no other route. Any other path or method returns `404` with `{"error":"not found"}`. The code is in `src/execution-service.ts` and `src/external-release.ts`.

The route accepts two kinds of JSON body, and tells them apart by shape:

| Body has | Kind | Authenticated by |
| --- | --- | --- |
| `release` and `signature` objects | A signed release from parmana-core, under ADR-0013 | The signature. No bearer token |
| `businessTransactionId`, `action`, `target`, `parameters`, `authorization` | A signed authorization, sent as the execution request | A bearer token in the `Authorization` header, then the signed envelope |

A body of either kind is checked as described below. A body that is neither returns `400`.

## Limits

| Limit | Value |
| --- | --- |
| Request body | 256 KB. A larger body returns `400` |
| Result returned to parmana-core, for a release | 16 KB, as JSON |
| Connector call | `PARMANA_CONNECTOR_TIMEOUT_MS`, default 10 s, applied by the generic connector |
| Clock skew allowed on a release's expiry | 30 seconds |

## Signed release

parmana-core POSTs `{ release, signature }`. Its fields and their rules:

| Field | Rule |
| --- | --- |
| `release.version` | Must be `1` |
| `release.businessTransactionId`, `release.capability`, `release.target`, `release.audience`, `release.expiresAt` | Non-empty strings |
| `release.parameters` | An object |
| `signature.algorithm` | Must be `ed25519` |
| `signature.keyId` | Must be `default` |
| `signature.value` | Base64 Ed25519 signature over the canonical serialization of `release`, from `@parmana/crypto` |

The other fields (`connectorId`, `authorizationId`, `policy`, `approvedBy`, `issuedAt`, `conditions`) are covered by the signature but are not checked by this service.

### Checks

1. The endpoint has a release audience (`PARMANA_RELEASE_AUDIENCE`). If not, the answer is `503`, and the service runs nothing.
2. Every shape, signature, audience, capability and expiry check runs, and a refused release lists every reason found.
3. The key `release:<businessTransactionId>` is recorded in the replay store before the connector runs. A second release with the same id is refused with `this businessTransactionId was already executed`.

The release's `capability` must be one the endpoint serves, the capabilities of the manifest. A release for any other capability is refused with `403` (`release.capability "..." is not served by this endpoint`) before its replay record is written, so the same release can be sent again with a corrected capability and a fresh signature.

### Answers

`200` when the release ran (the connector may still have failed):

```json
{
  "businessTransactionId": "txn-...",
  "capability": "...",
  "success": true,
  "result": { "status": 200, "body": { } },
  "executedAt": "2026-10-29T15:00:01.000Z"
}
```

If the connector failed, `success` is `false` and `result` is `{"error":"connector failed: <code>"}`. The code is one of `unknown_capability`, `invalid_input`, `credential_invalid`, `upstream_error` or `timeout`. If the result is larger than 16 KB, `success` is `false` and `result` is `{"error":"result is larger than 16 KB"}`.

`403` when a check refused the release, with every reason:

```json
{ "error": "release refused", "errors": ["the signature does not verify"] }
```

Nothing ran. A release refused for any reason other than the replay check can be sent again with a fresh signature.

`503` when no release audience is configured: `{"error":"this endpoint has no release audience configured"}`.

## Signed authorization

This is the request body from parmana-core's `HttpExecutionSystem`. It must carry the bearer token:

```
Authorization: Bearer <PARMANA_SERVICE_BEARER_TOKEN>
```

The body has `businessTransactionId`, `action`, `target`, `parameters` (an object) and `authorization`, the signed envelope from `@parmana/shared`.

### Checks, in order

1. **Bearer token.** Compared in constant time. A missing or wrong token returns `401` with `{"error":"unauthorized"}`.
2. **Authorization present.** Without an `authorization` field, `401` with `{"error":"authorization required"}`.
3. **Shape.** `businessTransactionId`, `action` and `target` must be strings, and `parameters` an object. Otherwise `400`.
4. **Envelope.** The signature, expiry, time-to-live and nonce are checked by `@parmana/envelope-verifier`. The nonce is used up here. A failure returns `403` with `{"error":"authorization invalid","checks":{...}}`.
5. **Content hash.** The service recomputes the hash of `businessTransactionId`, `action`, `target` and `parameters`, and compares it with the hash in the signed payload. A mismatch returns `403`. Content that cannot be canonicalized returns `400`.
6. **Granted capability.** The signed payload's `grantedCapability` must equal `action`. Otherwise `403` with `{"error":"authorization does not cover this action"}`.

### Answers

`200` when the connector ran:

```json
{
  "businessTransactionId": "...",
  "action": "...",
  "target": "...",
  "parameters": { },
  "success": true,
  "executedAt": "2026-10-29T15:00:01.000Z",
  "metadata": { "status": 200, "body": { } }
}
```

When the connector fails, the status depends on the connector's error code, and the body is `{"error":"connector failed: <code>"}`:

| Connector code | Status |
| --- | --- |
| `unknown_capability`, `invalid_input` | `422` |
| `upstream_error`, `timeout` | `502` |
| `credential_invalid`, anything else | `500` |

## Status codes

| Status | Meaning |
| --- | --- |
| `200` | The request was processed. For a release, the connector may still have failed (`success: false`) |
| `400` | Not JSON, not an object, over 256 KB, missing a required field, or content that cannot be canonicalized |
| `401` | Missing or wrong bearer token, or no `authorization` in an authorization request |
| `403` | A release or authorization was refused. Nothing ran |
| `404` | Any route or method other than `POST /execute` |
| `422`, `502`, `500` | The connector failed, as in the table above |
| `503` | A release arrived but no release audience is configured |

## Logs

The service writes to stdout with `console.log` and `console.error`. It does not write structured log lines. It logs the port it listens on, and an error message if it fails to start. The connector's error detail is not returned to the caller, and the credential is never logged. [Known differences](#known-differences) lists what this leaves out.

## Known differences

- **Error detail.** The caller gets only the connector's error code. The connector's message is not logged, unlike the connectors repository's service.
- **Body too large.** Returns `400`, not `413`.
