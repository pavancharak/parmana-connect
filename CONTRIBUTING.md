# Contributing to parmana-connect

Changes reach `main` through a pull request. Nothing is pushed to `main` directly.

## Before you open a pull request

- Install with `npm ci` and run `npm run build`, `npm run typecheck` and `npm test`.
- Tests that use PostgreSQL run only when `PARMANA_TEST_DATABASE_URL` is set. CI sets it.
- Sign off every commit with `git commit -s`. The DCO check fails a pull request with an unsigned commit.

## Required checks

A pull request can merge only when these pass:

| Check            | What it does                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `build-and-test` | Builds, typechecks and runs the full test suite against PostgreSQL.                                            |
| `DCO`            | Every commit has a `Signed-off-by` line.                                                                       |
| `gitleaks`       | Scans the change for committed secrets.                                                                        |
| `actionlint`     | Checks every workflow file. A workflow that does not parse runs no jobs.                                       |
| `audit`          | Fails on critical findings in production dependencies. High findings are reported in the log and do not block. |

## Dependencies

The four `@parmana/*` packages are published 0.1.0 versions. Do not change them to `file:` paths. A local link works only on one machine, and CI cannot install it.

`npm audit` reports high-severity findings in `@parmana/crypto` and its dependencies. They have no fix yet, so they do not block. Do not hide them from the log.

## Secrets

Never commit a key, token or connection string. Configuration comes from the environment. See [docs/END-TO-END.md](docs/END-TO-END.md#3-start-the-execution-service) for the settings.
