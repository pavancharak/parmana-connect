import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CREATE_NONCE_TABLE_SQL, NONCE_TABLE, PostgresNonceStore } from "../src/postgres-nonce-store.js";

// Runs against a real PostgreSQL when PARMANA_TEST_DATABASE_URL is set, and is
// skipped otherwise. CI provides a database.
const url = process.env.PARMANA_TEST_DATABASE_URL;

describe.skipIf(url === undefined)("PostgresNonceStore", () => {
  let pool: Pool;
  let store: PostgresNonceStore;
  const future = () => new Date(Date.now() + 60_000).toISOString();

  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await pool.query(CREATE_NONCE_TABLE_SQL);
    store = new PostgresNonceStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("accepts a nonce the first time and refuses it after", async () => {
    const nonce = randomUUID();

    expect(await store.checkAndRecord(nonce, future())).toBe(true);
    expect(await store.checkAndRecord(nonce, future())).toBe(false);
  });

  it("accepts different nonces", async () => {
    expect(await store.checkAndRecord(randomUUID(), future())).toBe(true);
    expect(await store.checkAndRecord(randomUUID(), future())).toBe(true);
  });

  it("lets exactly one of two concurrent attempts record the same nonce", async () => {
    const nonce = randomUUID();
    const [first, second] = await Promise.all([
      store.checkAndRecord(nonce, future()),
      store.checkAndRecord(nonce, future()),
    ]);

    expect([first, second].sort()).toEqual([false, true]);
  });

  it("removes a row only after its authorization has expired by more than the margin", async () => {
    const nonce = randomUUID();
    const longExpired = new Date(Date.now() - 10 * 60_000).toISOString();
    await pool.query(`INSERT INTO ${NONCE_TABLE} (nonce, expires_at) VALUES ($1, $2)`, [nonce, longExpired]);

    // The next call purges rows expired more than five minutes ago.
    await store.checkAndRecord(randomUUID(), future());
    const remaining = await pool.query(`SELECT 1 FROM ${NONCE_TABLE} WHERE nonce = $1`, [nonce]);

    expect(remaining.rowCount).toBe(0);
  });

  it("keeps a row whose authorization expired only just now", async () => {
    const nonce = randomUUID();
    const justExpired = new Date(Date.now() - 30_000).toISOString();
    await pool.query(`INSERT INTO ${NONCE_TABLE} (nonce, expires_at) VALUES ($1, $2)`, [nonce, justExpired]);

    await store.checkAndRecord(randomUUID(), future());
    const remaining = await pool.query(`SELECT 1 FROM ${NONCE_TABLE} WHERE nonce = $1`, [nonce]);

    expect(remaining.rowCount).toBe(1);
  });
});
