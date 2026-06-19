import { describe, expect, it } from "vitest";
import pg from "pg";
import { initializeWorkflowPostgresSchema } from "../src/index.js";

// Gated on a real Postgres (same pattern as postgres-schema-init.test.ts).
const URL = process.env.MEDIA_TRACK_POSTGRES_URL;
const d = URL ? describe : describe.skip;

async function pkColumns(pool: pg.Pool, table: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) " +
      `WHERE i.indrelid='${table}'::regclass AND i.indisprimary`,
  );
  return r.rows.map((row) => row.attname as string).sort();
}

d("drive-scoped schema migration (Postgres)", () => {
  it("connected_storage_id is in the PK of tracked_seasons + episode_states; idempotent; NOT NULL", async () => {
    const pool = new pg.Pool({ connectionString: URL });
    try {
      await initializeWorkflowPostgresSchema(pool);
      await initializeWorkflowPostgresSchema(pool); // second run must be a no-op (idempotent)

      expect(await pkColumns(pool, "tracked_seasons")).toEqual(["connected_storage_id", "id"]);
      expect(await pkColumns(pool, "episode_states")).toEqual([
        "connected_storage_id",
        "episode_code",
        "tracked_season_id",
      ]);

      const col = await pool.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name='episode_states' AND column_name='connected_storage_id'",
      );
      expect(col.rows[0]?.is_nullable).toBe("NO");

      const tsCol = await pool.query(
        "SELECT is_nullable FROM information_schema.columns WHERE table_name='tracked_seasons' AND column_name='connected_storage_id'",
      );
      expect(tsCol.rows[0]?.is_nullable).toBe("NO");
    } finally {
      await pool.end();
    }
  });
});
