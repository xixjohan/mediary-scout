// Reproduce / verify the first-boot Postgres schema-init deadlock.
//
// Fires N concurrent initializeWorkflowPostgresSchema() calls from N independent
// pools (mimicking the worker + first HTTP requests, possibly in separate Next
// bundles, all racing to create the schema on an empty DB). Against a fresh DB
// this used to deadlock (SQLSTATE 40P01); with the advisory-lock fix all N
// inits succeed.
//
// Usage: node scripts/repro-schema-deadlock.mjs [concurrency]
import pg from "pg";
import { initializeWorkflowPostgresSchema } from "../packages/workflow/dist/postgres.js";

const ADMIN_URL = process.env.REPRO_ADMIN_URL ?? "postgresql://mediatrack:mediatrack@localhost:5432/postgres";
const CONCURRENCY = Number(process.argv[2] ?? 16);
const DB_NAME = `repro_schema_${Date.now()}_${Math.floor(Math.random() * 1e6)}`.toLowerCase();

async function withAdmin(fn) {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function main() {
  await withAdmin((admin) => admin.query(`CREATE DATABASE ${DB_NAME}`));
  const base = new URL(ADMIN_URL.replace("postgresql://", "http://"));
  const dbUrl = `postgresql://${base.username}:${base.password}@${base.host}/${DB_NAME}`;
  console.log(`[repro] fresh DB ${DB_NAME}, firing ${CONCURRENCY} concurrent schema inits`);

  const pools = Array.from({ length: CONCURRENCY }, () => {
    const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
    // Idle pg clients emit 'error' when the backend is terminated by the FORCE
    // drop below; swallow so the harness exits cleanly (irrelevant to the test).
    pool.on("error", () => {});
    return pool;
  });
  const results = await Promise.allSettled(pools.map((pool) => initializeWorkflowPostgresSchema(pool)));
  await Promise.all(pools.map((pool) => pool.end()));

  const failures = results.filter((r) => r.status === "rejected");
  const deadlocks = failures.filter((r) => String(r.reason?.code) === "40P01" || /deadlock/i.test(String(r.reason)));
  console.log(`[repro] ${results.length - failures.length}/${results.length} succeeded, ${failures.length} failed, ${deadlocks.length} deadlocks`);
  for (const f of failures.slice(0, 3)) {
    console.log(`[repro]   failure: code=${f.reason?.code} ${String(f.reason).slice(0, 140)}`);
  }

  await withAdmin((admin) => admin.query(`DROP DATABASE ${DB_NAME} WITH (FORCE)`));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error("[repro] harness error:", error);
  try {
    await withAdmin((admin) => admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  } catch {}
  process.exit(2);
});
