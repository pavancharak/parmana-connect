import type { NonceStore } from "@parmana/envelope-verifier";
import type { Pool } from "pg";

export const NONCE_TABLE = "parmana_connect_nonces";

/**
 * Creates the table that holds single-use nonces. Safe to run more than once.
 */
export const CREATE_NONCE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${NONCE_TABLE} (
    nonce text PRIMARY KEY,
    expires_at timestamptz NOT NULL
  )`;

/**
 * Rows are removed only this long after their authorization expires. The margin
 * covers clock differences between this service and the database. An
 * authorization is refused once it expires, so a removed row cannot be reused
 * unless the clocks disagree by more than the margin.
 */
const PURGE_MARGIN = "5 minutes";

/**
 * A nonce store shared by every instance of the service. The primary key makes
 * the insert atomic: when two instances race on one nonce, exactly one insert
 * succeeds.
 */
export class PostgresNonceStore implements NonceStore {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async checkAndRecord(nonce: string, expiresAt: string): Promise<boolean> {
    await this.pool.query(
      `DELETE FROM ${NONCE_TABLE} WHERE expires_at < now() - interval '${PURGE_MARGIN}'`,
    );
    const result = await this.pool.query(
      `INSERT INTO ${NONCE_TABLE} (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING`,
      [nonce, expiresAt],
    );
    return result.rowCount === 1;
  }
}
