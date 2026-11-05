import { emit } from "../events.js";
import type { Actor, AuditLog } from "../auth/audit.js";
import { NoAuditLog } from "../auth/audit.js";
import { loadRun, saveRun } from "./runStore.js";
import type { ActivityEntry } from "./types.js";

/*
 * Who did what to a run. Every user action (launch, approval decision, jump,
 * skip, abort, worktree removal, archive, delete) is appended to the run's
 * `activity` list in run.json (shown on the run page) and to the Postgres
 * audit log when one is configured (kept even after a run is deleted).
 */

const MAX_ACTIVITY = 300;
let audit: AuditLog = new NoAuditLog();

export function setAuditLog(a: AuditLog): void {
  audit = a;
}

export function auditLog(): AuditLog {
  return audit;
}

export async function recordActivity(
  runId: string,
  actor: Actor,
  action: string,
  details: Record<string, unknown> = {},
  ip?: string,
): Promise<void> {
  const record = loadRun(runId);
  if (record) {
    const entry: ActivityEntry = { at: new Date().toISOString(), by: { sub: actor.sub, name: actor.name }, action, details };
    record.activity = [...(record.activity ?? []), entry].slice(-MAX_ACTIVITY);
    saveRun(record);
    emit({ type: "run.activity", runId, entry });
  }
  await audit.record({ actor, action, runId, details, ip });
}
