import type { Pool } from "pg";

/**
 * Records what this endpoint did for each release, so a repeat gets the first
 * answer and never a second execution (parmana-core ADR-0013).
 *
 * claim() is atomic: exactly one caller for a businessTransactionId gets
 * `claimed: true` and may execute. Every other caller gets the stored answer,
 * or `claimed: false` with no answer while the first execution is still in
 * progress. complete() stores the answer the first caller produced.
 *
 * A claim with no answer is never released. If the process stops after it
 * executed but before it stored the answer, the id stays unanswered, and a
 * repeat is refused with 409. Nothing runs twice, and an operator resolves it.
 */
export interface ReleaseLedger {
  claim(
    businessTransactionId: string,
    expiresAt: string,
  ): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }>;
  complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void>;
}

export const RELEASE_LEDGER_TABLE = "parmana_connect_release_ledger";

export const CREATE_RELEASE_LEDGER_SQL = `
  CREATE TABLE IF NOT EXISTS ${RELEASE_LEDGER_TABLE} (
    business_transaction_id text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    answer jsonb
  )`;

/** One process only. Use the Postgres ledger when more than one instance runs. */
export class MemoryReleaseLedger implements ReleaseLedger {
  private readonly entries = new Map<string, Record<string, unknown> | null>();

  async claim(businessTransactionId: string): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }> {
    if (this.entries.has(businessTransactionId)) {
      const answer = this.entries.get(businessTransactionId);
      return answer === null || answer === undefined ? { claimed: false } : { claimed: false, answer };
    }
    this.entries.set(businessTransactionId, null);
    return { claimed: true };
  }

  async complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void> {
    this.entries.set(businessTransactionId, answer);
  }
}

/** Shared by every instance. The primary key makes the claim atomic across them. */
export class PostgresReleaseLedger implements ReleaseLedger {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async claim(
    businessTransactionId: string,
    expiresAt: string,
  ): Promise<{ claimed: true } | { claimed: false; answer?: Record<string, unknown> }> {
    const inserted = await this.pool.query(
      `INSERT INTO ${RELEASE_LEDGER_TABLE} (business_transaction_id, expires_at) VALUES ($1, $2)
       ON CONFLICT (business_transaction_id) DO NOTHING`,
      [businessTransactionId, expiresAt],
    );
    if (inserted.rowCount === 1) return { claimed: true };

    const existing = await this.pool.query(
      `SELECT answer FROM ${RELEASE_LEDGER_TABLE} WHERE business_transaction_id = $1`,
      [businessTransactionId],
    );
    const answer = existing.rows[0]?.answer as Record<string, unknown> | null | undefined;
    return answer === null || answer === undefined ? { claimed: false } : { claimed: false, answer };
  }

  async complete(businessTransactionId: string, answer: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `UPDATE ${RELEASE_LEDGER_TABLE} SET answer = $2 WHERE business_transaction_id = $1`,
      [businessTransactionId, JSON.stringify(answer)],
    );
  }
}
