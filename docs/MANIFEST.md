# Connector manifest

A manifest describes an HTTP system and the capabilities this service can run on it. The service runs one manifest, named by `PARMANA_CONNECTOR_MANIFEST`. A manifest needs no connector code. The code is in `src/manifest.ts` (loading and validation), `src/connector.ts` (the generic connector that runs it) and `schema/manifest.schema.json`.

## Loading

The manifest is YAML or JSON. Loading refuses:

- YAML aliases, and duplicate keys, so one file means one thing when read.
- Anything that fails the schema or the rules below.

At startup, an invalid manifest stops the service and the message names the first error and its path. The variable named by the manifest's `credential.secretRef` must also be set at startup, or the service stops. A missing secret therefore fails at startup, not on the first request.

## Fields

| Field | Type | Rule |
| --- | --- | --- |
| `system` | string | Lowercase letters, digits and hyphens. 2 to 41 characters. Starts with a letter |
| `baseUrl` | string | Absolute `https://` URL, 8 to 2048 characters. No credentials, query or fragment. A trailing slash is allowed |
| `apiVersion` | string | 1 to 64 characters. Recorded for people reading the manifest. The service does not send it |
| `credential.type` | `bearer` or `header` | `bearer` sends `Authorization: Bearer <value>`. `header` sends the value in `credential.headerName` |
| `credential.headerName` | string | Required when `type` is `header`. A header name of letters, digits and hyphens, up to 64 characters |
| `credential.secretRef` | string | An uppercase environment variable name, 3 to 128 characters, for example `EXAMPLE_TOKEN`. The service reads this variable for the upstream secret. Only the name appears in errors |
| `capabilities` | array | 1 to 200 entries |

Each capability:

| Field | Rule |
| --- | --- |
| `id` | `<system>:<name>`, lowercase. Must start with the manifest's `system`. Unique in the manifest |
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | Starts with `/`, up to 512 characters, no query or fragment. May contain `{name}` placeholders |
| `effect` | `read` or `write`. A `GET` cannot be a `write` |
| `input` | Up to 50 inputs. Each has a `type` (`string`, `number`, `integer`, `boolean`, `object` or `array`) and an optional `required` flag |

Further rules: a `write` capability must declare at least one input, and every `{name}` in its path must be a declared input marked `required: true`.

## What a call does

When the execution service runs a capability:

1. **Input check.** Each input the caller sends must be declared and of the right type. A missing required input, an undeclared input, or a wrong type is refused with `invalid_input`. No request is made.
2. **Credential check.** The upstream secret must be a non-empty string. An empty one is refused with `credential_invalid`, and the error names the variable, never its value.
3. **Request.** `{name}` placeholders are filled from the inputs and URL-encoded. For `POST`, `PUT` and `PATCH`, the other inputs go in a JSON body. For other methods they go in the query string.
4. **Headers.** `bearer` sends `Authorization: Bearer <secret>`. `header` sends the secret under `headerName`.
5. **Time limit.** The call is limited to the service's `PARMANA_CONNECTOR_TIMEOUT_MS`, or 10 seconds if the caller gives none. A call that runs past it fails with `timeout`.
6. **Redirects are refused.** The credential must never reach another host. A redirect fails with `upstream_error`.
7. **Answer.** A non-2xx status fails with `upstream_error`, naming the capability and the status. The response body is not included in the error. The body is read up to 1,000,000 bytes, and a larger one fails with `upstream_error`. A body whose content type is JSON is parsed, and a body that does not parse fails with `upstream_error`. Any other body is returned as text.

## Example

This example describes an HTTP service with one read capability. The names are placeholders. Use your own system's values, and a test credential for a public service.

```yaml
system: example
baseUrl: https://api.example.test/v1
apiVersion: "2026-01"
credential:
  type: bearer
  secretRef: EXAMPLE_TOKEN
capabilities:
  - id: example:get-thing
    method: GET
    path: /things/{id}
    effect: read
    input:
      id: { type: string, required: true }
      expand: { type: boolean }
```

Its capability is `example:get-thing`. Calling it with `{"id": "abc", "expand": true}` sends `GET https://api.example.test/v1/things/abc?expand=true` with the token in the `Authorization` header.

## Where the manifest is kept

`PARMANA_CONNECTOR_MANIFEST` is a path, read at startup. The repository does not include a manifest. `.env.example` names `manifests\httpbin.json`, a folder that is not in this repository, so the file must be created or copied from elsewhere before the service can start.
