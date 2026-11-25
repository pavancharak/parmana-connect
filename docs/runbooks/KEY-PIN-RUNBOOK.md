# Runbook: pin the Parmana public key on a connector

**Audience:** a partner or operator who runs a parmana-connect service in front of a business system.
**Purpose:** make the connector trust exactly one Parmana signing key, so that a replaced key file cannot start unnoticed. This closes gap G-134.
**Time:** about 30 minutes, plus the wait for a second person to confirm the value.

You need to read this document only. Every step, command and expected result is below.

---

## 1. What this does, in one paragraph

A connector accepts a "release" only if Parmana signed it. The connector checks that signature with a public key stored in a file, `PARMANA_PUBLIC_KEY_FILE`. If someone replaces that file with a different key, the connector would accept releases signed by the new key, and nothing would tell you. A **pin** is a fingerprint of the correct key, stored in the connector's settings. The connector compares the file's key against the pin each time it starts, and refuses to start on a mismatch.

Since this change, the pin is **required** while release-only mode is on, which is the default. A connector without a pin does not start.

---

## 2. Before you start

You need:

- [ ] Shell access to the host that runs the connector, with the same environment variables the service uses.
- [ ] The Parmana public key file that the connector uses (`PARMANA_PUBLIC_KEY_FILE`). It is a public key in PEM format. It is **not** a private key. If the file contains `PRIVATE KEY`, stop and follow section 7.
- [ ] A named contact at the Parmana operator (the team that runs parmana-core), who can read out or confirm the fingerprint.
- [ ] A second channel to that contact that is **not** the channel that delivered the key file. Examples: a phone call to a number you already had, or an in-person check. Replying to the email that sent the key does not count.
- [ ] Node.js 24 or later, and the connector built from a commit that includes the key-pin change (branch `claude/g-134-pin-connector-key` or any later version).

Install and build once:

```bash
cd parmana-connect
npm ci
npm run build
```

---

## 3. Find the fingerprint of the key on disk

The connector's own doctor prints it. Run it with the same environment as the service:

```bash
npm run doctor
```

Doctor will report the key check as failing with a line like this, because no pin is set yet:

```
PARMANA_PUBLIC_KEY_FILE  fail  key fingerprint is sha256:<64 hex characters>, and no pin is set while release-only is on
```

Copy the `sha256:` value. **Doctor exits with status 1 at this stage. That is expected.** It also means nothing else in your configuration is broken, if no other line fails.

You can also compute the fingerprint without the connector, with the same formula the connector uses (SHA-256 of the key's SPKI DER encoding):

```bash
node -e 'const c=require("crypto");const k=c.createPublicKey(require("fs").readFileSync(process.argv[1]));console.log("sha256:"+c.createHash("sha256").update(k.export({type:"spki",format:"der"})).digest("hex"))' /path/to/parmana-public-key.pem
```

Both methods print the same value. This was checked against the connector's own function.

---

## 4. Confirm the fingerprint through a second channel

1. Send the `sha256:` value to your Parmana contact **through the second channel**. A phone call to a known number is best. Read it in groups of eight characters.
2. The contact computes the fingerprint of the key they **published** (they can use the same one-liner in section 3), and reads it back.
3. Compare the two values character by character. Do not proceed on a partial match.
4. Record who confirmed it, the date and the channel. You need this for the records in section 8.

If the values differ, **stop**. Do not pin the value on disk. See section 6.

---

## 5. Pin the confirmed value and verify

Set the confirmed value in the environment the service reads. Use your secret store or deployment settings. Do not commit it to a file in the repository.

```bash
export PARMANA_EXPECTED_KEY_FINGERPRINT=sha256:<the confirmed 64 hex characters>
```

Run doctor again:

```bash
npm run doctor
```

The key check should now pass:

```
PARMANA_PUBLIC_KEY_FILE  pass  key fingerprint matches the pinned value
```

Doctor must exit 0 for the key check. If other checks fail, fix them first. Each failure line gives its own fix.

Start the service:

```bash
npm start
```

It should start normally. Then check the health endpoint of your deployment.

**Negative test (recommended once):** point `PARMANA_EXPECTED_KEY_FINGERPRINT` at a wrong value, for example by changing one character. The service must refuse to start with a message that names `PARMANA_EXPECTED_KEY_FINGERPRINT`. Restore the correct value afterwards.

---

## 6. When something does not match

| What you see                                                                                          | What it means                               | What to do                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup refuses: `PARMANA_EXPECTED_KEY_FINGERPRINT is required while PARMANA_RELEASE_ONLY is on`      | No pin is set.                              | Complete sections 3 to 5.                                                                                                                                                                                        |
| Startup refuses: `PARMANA_EXPECTED_KEY_FINGERPRINT does not match the key in PARMANA_PUBLIC_KEY_FILE` | The file on disk is not the key you pinned. | Do not change the pin to make it start. Compare the file's fingerprint with the confirmed value. If the file is wrong, replace it from the confirmed source. If Parmana rotated its key, go to "Rotation" below. |
| Doctor: `key fingerprint is ... and no pin is set` on a development machine                           | Expected when you run locally.              | Use a local key and set `PARMANA_ALLOW_UNPINNED_KEY=true` for that machine only. Never set it in production.                                                                                                     |

### Rotation

Parmana may rotate its key. A rotation is legitimate only when Parmana announces it and the new fingerprint is confirmed through a second channel.

1. Confirm the new fingerprint as in section 4.
2. Put the new key file in place.
3. Update `PARMANA_EXPECTED_KEY_FINGERPRINT` to the new confirmed value.
4. Run doctor, then restart the service.
5. Record the rotation in your own change log, with the confirmation details.

The connector stops on a mismatch by design. That stop is the protection working.

---

## 7. If the file holds a private key

The file must hold only the public key. If it contains a private key (`-----BEGIN PRIVATE KEY-----`), treat that private key as compromised:

1. Stop the service.
2. Tell the Parmana operator immediately, by the second channel.
3. Replace the file with the public key from the operator.
4. Rotate any credential the connector used to sign or hold.

Doctor reports a private key as a failure. Do not pin a fingerprint over a private key file.

---

## 8. What to send back to Parmana (evidence)

The parmana-core records need these items to close G-134. Send them to the owner. Do not include the connector's secrets.

- The commit SHA of parmana-connect you ran, and whether it includes `13d17e5` or later.
- The `sha256:` fingerprint you pinned. This is a public value and safe to share.
- Who confirmed it, the date, and the channel used.
- The doctor output after pinning (the key-check line and the exit status). Do not paste the environment.
- The result of the negative test in section 5, or "not run" with the reason.
- The deployment name and date the service started with the pin.

---

## 9. Do not

- Do not confirm a fingerprint through the same channel that delivered the key file.
- Do not set `PARMANA_ALLOW_UNPINNED_KEY=true` on any shared or production host.
- Do not change the pinned value to make a refused start succeed, unless you have confirmed a rotation as in section 6.
- Do not commit the fingerprint or the environment to the repository. Keep them in your deployment settings. (The fingerprint itself is public, but keeping the pin with the deployment keeps the change visible.)
- Do not disable `PARMANA_RELEASE_ONLY` to get around this. Turning it off opens a second route that is not bound to a connector identity, which is a separate, weaker setting.

---

## 10. Rollback

If the pinned connector cannot start and you need the previous version back, run the previous release. That release does not require the pin, so the change is reversible by redeploying it. Do not roll back by setting `PARMANA_ALLOW_UNPINNED_KEY=true` in production.

---

## Reference

- Settings: `PARMANA_PUBLIC_KEY_FILE`, `PARMANA_EXPECTED_KEY_FINGERPRINT`, `PARMANA_RELEASE_ONLY`, `PARMANA_ALLOW_UNPINNED_KEY`. See the README's settings table.
- Doctor: [docs/DOCTOR.md](../DOCTOR.md).
- Gap: G-134 in parmana-core's `docs/internal/VERIFICATION-GAPS.md`.
