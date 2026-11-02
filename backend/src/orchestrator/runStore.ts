import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import type { RepoTarget, RoleAttempt, RoleId, RunRecord, RunSource, RunState } from "./types.js";

function runDir(runId: string) {
  return join(paths.runsDir, runId);
}

function runFile(runId: string) {
  return join(runDir(runId), "run.json");
}

export function createRun(input: {
  runId: string;
  label: string;
  source: RunSource;
  repos: RepoTarget[];
}): RunRecord {
  if (input.repos.length === 0) throw new Error("createRun requires at least one repo");
  const now = new Date().toISOString();
  const record: RunRecord = {
    runId: input.runId,
    label: input.label,
    source: input.source,
    repos: input.repos,
    state: "created",
    createdAt: now,
    updatedAt: now,
    roles: {},
    stateHistory: [],
    pendingApproval: null,
  };
  mkdirSync(runDir(input.runId), { recursive: true });
  writeFileSync(runFile(input.runId), JSON.stringify(record, null, 2));
  return record;
}

export function loadRun(runId: string): RunRecord | null {
  const file = runFile(runId);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as RunRecord;
}

export function saveRun(record: RunRecord): void {
  record.updatedAt = new Date().toISOString();
  writeFileSync(runFile(record.runId), JSON.stringify(record, null, 2));
}

export function listRuns(): RunRecord[] {
  if (!existsSync(paths.runsDir)) return [];
  const out: RunRecord[] = [];
  for (const entry of readdirSync(paths.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const run = loadRun(entry.name);
    if (run) out.push(run);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function transition(record: RunRecord, to: RunState, reason?: string): void {
  if (record.state === to) return;
  record.stateHistory.push({ at: new Date().toISOString(), from: record.state, to, reason });
  record.state = to;
}

export function startAttempt(record: RunRecord, role: RoleId): RoleAttempt {
  const attempt: RoleAttempt = {
    startedAt: new Date().toISOString(),
    status: "running",
  };
  const bucket = record.roles[role] ?? [];
  bucket.push(attempt);
  record.roles[role] = bucket;
  return attempt;
}

export function latestAttempt(record: RunRecord, role: RoleId): RoleAttempt | undefined {
  const bucket = record.roles[role];
  return bucket && bucket.length > 0 ? bucket[bucket.length - 1] : undefined;
}
