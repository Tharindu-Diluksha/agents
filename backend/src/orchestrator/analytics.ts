import { ROLES, type RoleAttempt, type RoleId, type RunRecord, type RunState } from "./types.js";
import { stacksOf } from "../stacks.js";

/*
 * Cross-run analytics and exports. Pure functions over run records, so the
 * same numbers back the analytics page, the CSV export and the tests.
 */

export interface AttemptRow {
  runId: string;
  label: string;
  archived: boolean;
  role: RoleId;
  attempt: number;
  /** Run state the attempt started in, e.g. unit_tests_red_running. */
  phase: string;
  model: string;
  status: RoleAttempt["status"];
  startedAt: string;
  endedAt: string;
  durationSec: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  numTurns: number | null;
}

export interface RunRow {
  runId: string;
  label: string;
  archived: boolean;
  state: RunState;
  stacks: string;
  createdAt: string;
  /** Minutes from creation to `done`/`failed`, or to now/last update when still open. */
  durationMin: number | null;
  costUsd: number;
  tokens: number;
  fixIterations: number;
  attempts: number;
}

export interface RoleStats {
  role: RoleId;
  attempts: number;
  costUsd: number;
  tokens: number;
  avgCostPerAttempt: number;
  avgDurationSec: number | null;
  byStatus: Partial<Record<RoleAttempt["status"], number>>;
}

export interface ReasonCount {
  reason: string;
  count: number;
  lastRunId: string;
}

export interface Analytics {
  runs: number;
  byState: Partial<Record<RunState, number>>;
  costUsd: number;
  tokens: number;
  avgCostPerDoneRun: number | null;
  medianDoneDurationMin: number | null;
  avgFixIterations: number | null;
  roles: RoleStats[];
  pauseReasons: ReasonCount[];
  failureReasons: ReasonCount[];
  runRows: RunRow[];
}

type Archivable = RunRecord & { archived?: boolean };

const tokensOf = (a: RoleAttempt) =>
  a.usage ? a.usage.inputTokens + a.usage.outputTokens + a.usage.cacheReadInputTokens + a.usage.cacheCreationInputTokens : 0;

const secondsBetween = (a?: string, b?: string) => (a && b ? Math.max(0, (Date.parse(b) - Date.parse(a)) / 1000) : null);

export function attemptRows(records: Archivable[]): AttemptRow[] {
  const rows: AttemptRow[] = [];
  for (const r of records) {
    for (const role of ROLES) {
      (r.roles[role] ?? []).forEach((a, i) => {
        rows.push({
          runId: r.runId,
          label: r.label,
          archived: Boolean(r.archived),
          role,
          attempt: i + 1,
          phase: a.state ?? "",
          model: a.model ?? "",
          status: a.status,
          startedAt: a.startedAt,
          endedAt: a.endedAt ?? "",
          durationSec: secondsBetween(a.startedAt, a.endedAt),
          costUsd: a.costUsd ?? 0,
          inputTokens: a.usage?.inputTokens ?? 0,
          outputTokens: a.usage?.outputTokens ?? 0,
          cacheReadInputTokens: a.usage?.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: a.usage?.cacheCreationInputTokens ?? 0,
          numTurns: a.numTurns ?? null,
        });
      });
    }
  }
  return rows.sort((x, y) => x.startedAt.localeCompare(y.startedAt));
}

function endOf(r: RunRecord): string | undefined {
  if (r.state !== "done" && r.state !== "failed") return undefined;
  return [...r.stateHistory].reverse().find((h) => h.to === r.state)?.at ?? r.updatedAt;
}

export function runRows(records: Archivable[]): RunRow[] {
  return records.map((r) => {
    const all = ROLES.flatMap((role) => r.roles[role] ?? []);
    const end = endOf(r) ?? r.updatedAt;
    const secs = secondsBetween(r.createdAt, end);
    return {
      runId: r.runId,
      label: r.label,
      archived: Boolean(r.archived),
      state: r.state,
      stacks: r.repos.map((repo) => stacksOf(repo).join("+")).join(", "),
      createdAt: r.createdAt,
      durationMin: secs === null ? null : Math.round((secs / 60) * 10) / 10,
      costUsd: all.reduce((s, a) => s + (a.costUsd ?? 0), 0),
      tokens: all.reduce((s, a) => s + tokensOf(a), 0),
      fixIterations: r.fixIterations ?? 0,
      attempts: all.length,
    };
  });
}

/** Reasons are grouped by their first line, with numbers and ids normalised so similar ones count together. */
function normaliseReason(reason: string): string {
  return reason
    .split("\n")[0]!
    .replace(/\b[0-9a-f]{7,}\b/gi, "…")
    .replace(/\d+/g, "N")
    .trim()
    .slice(0, 140);
}

function countReasons(items: Array<{ reason: string | undefined; runId: string }>): ReasonCount[] {
  const map = new Map<string, ReasonCount>();
  for (const { reason, runId } of items) {
    if (!reason) continue;
    const key = normaliseReason(reason);
    const cur = map.get(key) ?? { reason: key, count: 0, lastRunId: runId };
    cur.count++;
    cur.lastRunId = runId;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 15);
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function computeAnalytics(records: Archivable[]): Analytics {
  const rows = runRows(records);
  const attempts = attemptRows(records);
  const byState: Analytics["byState"] = {};
  for (const r of records) byState[r.state] = (byState[r.state] ?? 0) + 1;

  const done = rows.filter((r) => r.state === "done");
  const roles: RoleStats[] = ROLES.map((role) => {
    const mine = attempts.filter((a) => a.role === role);
    const durations = mine.map((a) => a.durationSec).filter((d): d is number => d !== null);
    const byStatus: RoleStats["byStatus"] = {};
    for (const a of mine) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    const cost = mine.reduce((s, a) => s + a.costUsd, 0);
    return {
      role,
      attempts: mine.length,
      costUsd: cost,
      tokens: mine.reduce((s, a) => s + a.inputTokens + a.outputTokens + a.cacheReadInputTokens + a.cacheCreationInputTokens, 0),
      avgCostPerAttempt: mine.length ? cost / mine.length : 0,
      avgDurationSec: durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : null,
      byStatus,
    };
  });

  // Pauses and failures over the run's whole history, not just its current state.
  const pauses: Array<{ reason: string | undefined; runId: string }> = [];
  const failures: Array<{ reason: string | undefined; runId: string }> = [];
  for (const r of records) {
    for (const h of r.stateHistory) {
      if (h.to === "paused") pauses.push({ reason: h.reason, runId: r.runId });
      if (h.to === "failed") failures.push({ reason: h.reason, runId: r.runId });
    }
  }

  return {
    runs: records.length,
    byState,
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    tokens: rows.reduce((s, r) => s + r.tokens, 0),
    avgCostPerDoneRun: done.length ? done.reduce((s, r) => s + r.costUsd, 0) / done.length : null,
    medianDoneDurationMin: median(done.map((r) => r.durationMin).filter((d): d is number => d !== null)),
    avgFixIterations: rows.length ? rows.reduce((s, r) => s + r.fixIterations, 0) / rows.length : null,
    roles,
    pauseReasons: countReasons(pauses),
    failureReasons: countReasons(failures),
    runRows: rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** RFC 4180 CSV. */
export function toCsv<T extends object>(rows: T[], columns: Array<keyof T & string>): string {
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export const ATTEMPT_COLUMNS: Array<keyof AttemptRow & string> = [
  "runId",
  "label",
  "archived",
  "role",
  "attempt",
  "phase",
  "model",
  "status",
  "startedAt",
  "endedAt",
  "durationSec",
  "costUsd",
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "numTurns",
];
