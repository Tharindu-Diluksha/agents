import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import type { AttemptUsage, RepoTarget, RoleAttempt, RoleId, RunRecord, RunSource, RunState } from "./types.js";

/**
 * Run records are cached in memory so every caller (routes, workflow, a
 * still-running role) mutates the same object. Without the cache, an approval
 * request loads a fresh copy from disk while a role holds an older one, and
 * whichever saves last silently drops the other's changes.
 */
const cache = new Map<string, RunRecord>();

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
  models?: Partial<Record<RoleId, string>>;
  createdBy?: { sub: string; name: string };
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
    models: input.models,
    createdBy: input.createdBy,
    fixIterations: 0,
    workspace: "worktree",
  };
  mkdirSync(runDir(input.runId), { recursive: true });
  cache.set(record.runId, record);
  writeAtomic(runFile(input.runId), JSON.stringify(record, null, 2));
  return record;
}

export function loadRun(runId: string): RunRecord | null {
  const cached = cache.get(runId);
  if (cached) return cached;
  const file = runFile(runId);
  if (!existsSync(file)) return null;
  const record = migrateLegacy(JSON.parse(readFileSync(file, "utf8")) as RunRecord);
  cache.set(runId, record);
  return record;
}

export function saveRun(record: RunRecord): void {
  record.updatedAt = new Date().toISOString();
  cache.set(record.runId, record);
  writeAtomic(runFile(record.runId), JSON.stringify(record, null, 2));
}

/** Write to a temp file and rename, so a crash mid-write never leaves a truncated run.json. */
function writeAtomic(file: string, body: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/** Archived runs live in runs/.archive/<runId>/ (artifacts and event log kept, worktrees and sessions gone). */
export function archiveDir(): string {
  return join(paths.runsDir, ".archive");
}

/** Drops a run from the in-memory cache (after it was archived or deleted on disk). */
export function forgetRun(runId: string): void {
  cache.delete(runId);
}

/** Archived run records, read-only and uncached. */
export function listArchivedRuns(): Array<RunRecord & { archived: true }> {
  const dir = archiveDir();
  if (!existsSync(dir)) return [];
  const out: Array<RunRecord & { archived: true }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(dir, entry.name, "run.json");
    if (!existsSync(file)) continue;
    try {
      out.push({ ...migrateLegacy(JSON.parse(readFileSync(file, "utf8")) as RunRecord), archived: true });
    } catch {
      // skip unreadable archives
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function listRuns(): RunRecord[] {
  if (!existsSync(paths.runsDir)) return [];
  const out: RunRecord[] = [];
  for (const entry of readdirSync(paths.runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const run = loadRun(entry.name);
      if (run) out.push(run);
    } catch {
      // Skip unreadable run folders instead of breaking the whole list.
    }
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
    state: record.state,
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

/** Sum of the SDK-reported cost of every attempt in the run. */
export function totalCostUsd(record: RunRecord): number {
  let total = 0;
  for (const attempts of Object.values(record.roles)) {
    for (const a of attempts ?? []) total += a.costUsd ?? 0;
  }
  return total;
}

/** Token usage summed over every attempt of one role, or the whole run. */
export function usageTotals(record: RunRecord, role?: RoleId): AttemptUsage {
  const total: AttemptUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const buckets = role ? [record.roles[role]] : Object.values(record.roles);
  for (const attempts of buckets) {
    for (const a of attempts ?? []) {
      if (!a.usage) continue;
      total.inputTokens += a.usage.inputTokens;
      total.outputTokens += a.usage.outputTokens;
      total.cacheReadInputTokens += a.usage.cacheReadInputTokens;
      total.cacheCreationInputTokens += a.usage.cacheCreationInputTokens;
    }
  }
  return total;
}

/**
 * Runs created before the Tester was split into Unit / Integration / E2E
 * testers used the role id `tester` and the state `tester_running`.
 */
function migrateLegacy(record: RunRecord): RunRecord {
  const roles = record.roles as Record<string, RoleAttempt[] | undefined>;
  if (roles.tester && !roles.e2eTester) {
    roles.e2eTester = roles.tester;
    delete roles.tester;
  }
  if ((record.state as string) === "tester_running") record.state = "e2e_tester_running";
  if (record.pendingApproval && (record.pendingApproval.role as string) === "tester") {
    record.pendingApproval.role = "e2eTester";
  }
  record.fixIterations ??= 0;
  // Runs from before per-run worktrees keep working in the user's checkout.
  record.workspace ??= "in-place";
  return record;
}
