import { Pool } from "pg";

import { CREATE_NONCE_TABLE_SQL } from "./postgres-nonce-store.js";

/**
 * Creates the tables the service needs. Run it once before the first start, and
 * again after an upgrade. It reads PARMANA_DATABASE_URL.
 */
async function main(): Promise<void> {
  const url = process.env.PARMANA_DATABASE_URL;
  if (url === undefined || url.trim() === "") {
    throw new Error("PARMANA_DATABASE_URL is required");
  }
  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(CREATE_NONCE_TABLE_SQL);
    console.log("migration applied");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`migration failed: ${err instanceof Error ? err.message : "unknown error"}`);
  process.exit(1);
});
