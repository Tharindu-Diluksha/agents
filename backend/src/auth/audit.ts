import type { Db } from "./db.js";
import { log } from "../log.js";

export interface Actor {
  sub: string;
  name: string;
  email?: string | null;
}

export interface AuditEntry {
  id: number;
  at: string;
  userSub: string | null;
  userName: string | null;
  action: string;
  runId: string | null;
  outcome: "ok" | "denied" | "failed";
  details: Record<string, unknown>;
  ip: string | null;
}

export interface AuditInput {
  actor: Actor | null;
  action: string;
  runId?: string | null;
  outcome?: AuditEntry["outcome"];
  details?: Record<string, unknown>;
  ip?: string | null;
}

export interface AuditQuery {
  limit?: number;
  before?: number; // id cursor
  runId?: string;
  userSub?: string;
  action?: string;
}

export interface AuditLog {
  readonly enabled: boolean;
  record(e: AuditInput): Promise<void>;
  list(q: AuditQuery): Promise<AuditEntry[]>;
}

/** Append-only. Writing never throws into the request path: a failed audit write is logged. */
export class PostgresAuditLog implements AuditLog {
  readonly enabled = true;
  constructor(private readonly db: Db) {}

  async record(e: AuditInput): Promise<void> {
    try {
      await this.db.query(
        "INSERT INTO audit_log (user_sub, user_name, action, run_id, outcome, details, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [e.actor?.sub ?? null, e.actor?.name ?? null, e.action, e.runId ?? null, e.outcome ?? "ok", JSON.stringify(e.details ?? {}), e.ip ?? null],
      );
    } catch (err) {
      log.error("audit.write_failed", { action: e.action, runId: e.runId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  async list(q: AuditQuery): Promise<AuditEntry[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      args.push(v);
      where.push(sql.replace("?", `$${args.length}`));
    };
    if (q.before) add("id < ?", q.before);
    if (q.runId) add("run_id = ?", q.runId);
    if (q.userSub) add("user_sub = ?", q.userSub);
    if (q.action) add("action = ?", q.action);
    args.push(Math.min(Math.max(q.limit ?? 100, 1), 500));
    const r = await this.db.query(
      `SELECT id, at, user_sub, user_name, action, run_id, outcome, details, ip FROM audit_log
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT $${args.length}`,
      args,
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      at: new Date(x.at).toISOString(),
      userSub: x.user_sub,
      userName: x.user_name,
      action: x.action,
      runId: x.run_id,
      outcome: x.outcome,
      details: x.details,
      ip: x.ip,
    }));
  }
}

/** Used when no DATABASE_URL is configured: actions still reach the run's activity list, not the audit table. */
export class NoAuditLog implements AuditLog {
  readonly enabled = false;
  async record(): Promise<void> {}
  async list(): Promise<AuditEntry[]> {
    return [];
  }
}
