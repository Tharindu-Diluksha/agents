import pg from "pg";
import { log } from "../log.js";

/*
 * Postgres access for sessions and the audit log. Migrations are plain SQL,
 * applied once each, in order, and recorded in schema_migrations.
 */

export type Db = pg.Pool;

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: "sessions and audit log",
    sql: `
      CREATE TABLE sessions (
        id_hash          text PRIMARY KEY,           -- sha256 of the cookie value; the value itself is never stored
        user_sub         text NOT NULL,
        user_name        text NOT NULL,
        email            text,
        roles            text[] NOT NULL DEFAULT '{}',
        id_token         text,                       -- for RP-initiated logout (id_token_hint)
        refresh_token    text,                       -- sealed (AES-256-GCM)
        access_expires_at timestamptz NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now(),
        last_seen_at     timestamptz NOT NULL DEFAULT now(),
        expires_at       timestamptz NOT NULL          -- absolute limit (SESSION_MAX_HOURS)
      );
      CREATE INDEX sessions_user_sub ON sessions (user_sub);
      CREATE INDEX sessions_expires_at ON sessions (expires_at);

      CREATE TABLE audit_log (
        id         bigserial PRIMARY KEY,
        at         timestamptz NOT NULL DEFAULT now(),
        user_sub   text,
        user_name  text,
        action     text NOT NULL,
        run_id     text,
        outcome    text NOT NULL DEFAULT 'ok',      -- ok | denied | failed
        details    jsonb NOT NULL DEFAULT '{}',
        ip         text
      );
      CREATE INDEX audit_log_at ON audit_log (at DESC);
      CREATE INDEX audit_log_run ON audit_log (run_id, at DESC);
      CREATE INDEX audit_log_user ON audit_log (user_sub, at DESC);
    `,
  },
];

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", (err) => log.error("db.pool_error", { err: err.message }));
  return pool;
}

export async function migrate(db: Db): Promise<number[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied = new Set((await db.query<{ version: number }>("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      // Serialise concurrent starts (two backends on one DB shouldn't happen, but be safe).
      await client.query("SELECT pg_advisory_xact_lock(4172025)");
      const again = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [m.version]);
      if (again.rowCount === 0) {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [m.version, m.name]);
        ran.push(m.version);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${m.version} (${m.name}) failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
  }
  if (ran.length) log.info("db.migrated", { versions: ran });
  return ran;
}
