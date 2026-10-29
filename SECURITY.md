# Security policy

This repository runs the service that accepts Parmana's authorizations and performs the actions they approve. A weakness here can run an action that was not approved, or expose a credential, so report it privately.

## Reporting a vulnerability

Do not open a public issue or a public pull request for a security problem.

Report it through the contact in parmana-core's security policy: [parmana-core SECURITY.md](https://github.com/pavancharak/parmana-core/blob/main/SECURITY.md). That policy gives the reporting address, the acknowledgement time, and what to include.

Do not put a live credential, a bearer token, a key pair, a database connection string or a customer's data in a report. Describe the problem, its impact, and the steps to reproduce. If a credential has been exposed, say so at once, so it can be rotated.

## Scope

In scope, for this repository:

- Verification of signed authorizations and signed releases, the replay store, and the bearer-token check (`src/execution-service.ts`, `src/external-release.ts`).
- The generic connector and its handling of credentials, redirects and responses (`src/connector.ts`).
- Configuration checks (`src/config.ts`).
- Anything that could make a credential appear in a log, an answer or an error.

Out of scope here: the policy engine and the signing side, which are in parmana-core.

## Secrets

Secrets are never committed. The bearer token, the public key file, the database URL and the upstream credential come from the environment or from files kept out of Git. See [docs/SETUP.md](docs/SETUP.md) for where each one is set.
