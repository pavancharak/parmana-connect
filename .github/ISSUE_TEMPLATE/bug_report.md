---
name: Bug report
about: Something the connector does wrongly
labels: bug
---

<!--
Do not report a security vulnerability here. Follow SECURITY.md, which asks for a private report.
Never paste a secret, bearer token, upstream credential, private key, or a full release that
contains customer data. Replace them with placeholders.
-->

## What happened

<!-- One or two sentences. -->

## Expected

<!-- What should have happened. Cite the spec or ADR if you know it, for example ADR-0013. -->

## Steps to reproduce

1.
2.
3.

<!-- If you can, attach a signed release fixture with secrets removed, and the size in bytes. -->

## Response

<!-- The HTTP status and body the endpoint returned. Remove any upstream body that may contain data. -->

```
status:
body:
```

## Environment

- Connector version or commit:
- Node.js version:
- Nonce store: postgres / memory
- Release size in bytes, if relevant:
- Signed by: parmana-core (version or commit) / other

## Checked

- [ ] I searched existing issues for this bug.
- [ ] I removed secrets and customer data from this report.
