import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import type { RoleId } from "./types.js";

interface SessionRecord {
  sessionId: string;
  lastRunAt: string;
}

function sessionDir(runId: string) {
  return join(paths.sessionsDir, runId);
}

function sessionFile(runId: string, role: RoleId) {
  return join(sessionDir(runId), `${role}.json`);
}

export function getSessionId(runId: string, role: RoleId): string | null {
  const file = sessionFile(runId, role);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
    return parsed.sessionId ?? null;
  } catch {
    return null;
  }
}

export function saveSessionId(runId: string, role: RoleId, sessionId: string): void {
  const dir = sessionDir(runId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const record: SessionRecord = { sessionId, lastRunAt: new Date().toISOString() };
  writeFileSync(sessionFile(runId, role), JSON.stringify(record, null, 2));
}
