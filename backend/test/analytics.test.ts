import { describe, expect, it } from "vitest";
import { attemptRows, computeAnalytics, runRows, toCsv, ATTEMPT_COLUMNS } from "../src/orchestrator/analytics.js";
import type { RunRecord } from "../src/orchestrator/types.js";

const usage = (n: number) => ({ inputTokens: n, outputTokens: n, cacheReadInputTokens: n, cacheCreationInputTokens: 0 });

function run(id: string, state: RunRecord["state"], extra: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: id,
    label: id.toUpperCase(),
    source: { kind: "manual", type: "feature", title: id, description: "d", acceptanceCriteria: [] },
    repos: [{ path: "/r", baseBranch: "main", aiGuidelinePath: null, stacks: ["python"] }],
    state,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T11:00:00.000Z",
    roles: {},
    stateHistory: [],
    pendingApproval: null,
    fixIterations: 0,
    ...extra,
  };
}

const a = run("a", "done", {
  fixIterations: 2,
  stateHistory: [
    { at: "2026-11-01T10:20:00.000Z", from: "integration_tester_running", to: "paused", reason: "fix-loop limit reached (3) — last trigger: x" },
    { at: "2026-11-01T10:30:00.000Z", from: "pr_creator_running", to: "done" },
  ],
  roles: {
    developer: [
      { startedAt: "2026-11-01T10:01:00.000Z", endedAt: "2026-11-01T10:03:00.000Z", status: "awaiting_approval", costUsd: 0.5, usage: usage(100), model: "m1", state: "developer_planning" },
      { startedAt: "2026-11-01T10:05:00.000Z", endedAt: "2026-11-01T10:09:00.000Z", status: "done", costUsd: 1.5, usage: usage(300), model: "m1", state: "developer_implementing" },
    ],
    reviewer: [{ startedAt: "2026-11-01T10:10:00.000Z", endedAt: "2026-11-01T10:11:00.000Z", status: "awaiting_approval", costUsd: 0.25, usage: usage(50) }],
  },
});
const b = run("b", "failed", {
  stateHistory: [
    { at: "2026-11-01T10:05:00.000Z", from: "created", to: "paused", reason: "fix-loop limit reached (2) — last trigger: y" },
    { at: "2026-11-01T10:06:00.000Z", from: "paused", to: "failed", reason: "Developer: terminal JSON missing" },
  ],
  roles: { developer: [{ startedAt: "2026-11-01T10:02:00.000Z", status: "failed", costUsd: 0.75 }] },
});

describe("computeAnalytics", () => {
  const an = computeAnalytics([a, { ...b, archived: true } as RunRecord & { archived: boolean }]);

  it("totals cost, tokens, states and fix loops", () => {
    expect(an.runs).toBe(2);
    expect(an.byState).toEqual({ done: 1, failed: 1 });
    expect(an.costUsd).toBeCloseTo(3.0);
    expect(an.tokens).toBe(300 + 900 + 150);
    expect(an.avgCostPerDoneRun).toBeCloseTo(2.25);
    expect(an.medianDoneDurationMin).toBe(30);
    expect(an.avgFixIterations).toBe(1);
  });

  it("breaks cost and outcomes down per role", () => {
    const dev = an.roles.find((r) => r.role === "developer")!;
    expect(dev.attempts).toBe(3);
    expect(dev.costUsd).toBeCloseTo(2.75);
    expect(dev.byStatus).toEqual({ awaiting_approval: 1, done: 1, failed: 1 });
    expect(dev.avgDurationSec).toBe(180); // the unfinished attempt is ignored
    expect(an.roles.find((r) => r.role === "analyst")!.attempts).toBe(0);
  });

  it("groups similar pause and failure reasons", () => {
    expect(an.pauseReasons).toHaveLength(2);
    expect(an.pauseReasons.map((r) => r.reason).sort()).toEqual([
      "fix-loop limit reached (N) — last trigger: x",
      "fix-loop limit reached (N) — last trigger: y",
    ]);
    expect(an.failureReasons).toEqual([{ reason: "Developer: terminal JSON missing", count: 1, lastRunId: "b" }]);
  });

  it("lists runs newest first with archived flag and stacks", () => {
    expect(an.runRows.map((r) => [r.runId, r.archived, r.stacks])).toEqual(
      expect.arrayContaining([
        ["a", false, "python"],
        ["b", true, "python"],
      ]),
    );
  });
});

describe("exports", () => {
  it("flattens attempts in start order with phase, model and usage", () => {
    const rows = attemptRows([a]);
    expect(rows.map((r) => [r.role, r.attempt, r.phase, r.durationSec, r.costUsd])).toEqual([
      ["developer", 1, "developer_planning", 120, 0.5],
      ["developer", 2, "developer_implementing", 240, 1.5],
      ["reviewer", 1, "", 60, 0.25],
    ]);
    expect(runRows([a])[0]).toMatchObject({ runId: "a", costUsd: 2.25, attempts: 3, fixIterations: 2, durationMin: 30 });
  });

  it("writes RFC 4180 CSV", () => {
    const csv = toCsv([{ x: 'say "hi", ok', y: 1 }, { x: "line\nbreak", y: null }], ["x", "y"]);
    expect(csv).toBe('x,y\r\n"say ""hi"", ok",1\r\n"line\nbreak",\r\n');
    const header = toCsv(attemptRows([a]), ATTEMPT_COLUMNS).split("\r\n")[0];
    expect(header).toBe(ATTEMPT_COLUMNS.join(","));
  });
});
