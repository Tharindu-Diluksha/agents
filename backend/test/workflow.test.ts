import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleOutput, RunState } from "../src/orchestrator/types.js";
import type { RunRoleAgentArgs, RunRoleAgentResult } from "../src/sdk/runRole.js";

/*
 * Drives the real state machine (workflow.ts + runStore + roles) with a
 * scripted fake of `runRoleAgent`, so no model is called. External actions
 * (git, gh, JIRA) are mocked.
 */

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "orch-test-"));
});

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return {
    ...orig,
    paths: {
      ...orig.paths,
      repoRoot: tmp,
      runsDir: join(tmp, "runs"),
      sessionsDir: join(tmp, "sessions"),
    },
    config: {
      ...orig.config,
      maxFixIterations: 3,
      maxRunCostUsd: 0,
      reviewAutoRoute: false,
    },
  };
});

type Script = (role: string, state: RunState, args: RunRoleAgentArgs) => Promise<RunRoleAgentResult> | RunRoleAgentResult;
let script: Script;
const calls: Array<{ role: string; state: RunState; prompt: string; model: string; extraTools: string[]; mcpServers: string[] }> = [];

vi.mock("../src/sdk/runRole.js", () => ({
  runRoleAgent: vi.fn(async (args: RunRoleAgentArgs) => {
    const { loadRun } = await import("../src/orchestrator/runStore.js");
    const state = loadRun(args.runId)!.state;
    calls.push({
      role: args.role,
      state,
      prompt: args.userPrompt,
      model: args.model,
      extraTools: args.extraTools ?? [],
      mcpServers: Object.keys(args.mcpServers ?? {}),
    });
    return script(args.role, state, args);
  }),
}));

const createPr = vi.fn(async (_input: { repoPath: string; baseBranch: string; body: string; titleHint: string }) => "https://github.com/acme/app/pull/1");
vi.mock("../src/external/gh.js", () => ({ createPr: (input: Parameters<typeof createPr>[0]) => createPr(input) }));
vi.mock("../src/external/git.js", () => ({
  checkoutOrCreateBranch: vi.fn(async () => "created"),
  currentBranch: vi.fn(async () => "master"),
}));
vi.mock("../src/external/jiraMcp.js", () => ({ postJiraComment: vi.fn(async () => undefined) }));

const { config } = await import("../src/config.js");
const { createRun, loadRun } = await import("../src/orchestrator/runStore.js");
const workflow = await import("../src/orchestrator/workflow.js");

const mutableConfig = config as unknown as { maxFixIterations: number; maxRunCostUsd: number; reviewAutoRoute: boolean };
const repoPath = join(tmp, "app");

function out(o: Partial<RoleOutput>): RunRoleAgentResult {
  return {
    sessionId: "s",
    output: { status: "done", artifacts: [], approvalRequest: null, handoff: null, ...o },
    metrics: { costUsd: 0.5, numTurns: 3, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
  };
}
const gate = (action: "proceed_to_next" | "create_pr" | "create_test_suite", payloadPaths: string[] = []) =>
  out({ status: "awaiting_approval", approvalRequest: { action, summary: action, payloadPaths } });

/** Default script: every role succeeds and requests its normal gate. */
function happyScript(runId: string): Script {
  return (role, state) => {
    switch (role) {
      case "analyst":
        return gate("proceed_to_next");
      case "developer":
        return state === "developer_planning" ? gate("proceed_to_next") : out({});
      case "reviewer":
        return gate("proceed_to_next");
      case "prCreator": {
        const rel = `runs/${runId}/prCreator/app-pr-description.md`;
        mkdirSync(join(tmp, "runs", runId, "prCreator"), { recursive: true });
        writeFileSync(join(tmp, rel), "# Add widget\n\nbody");
        return gate("create_pr", [rel]);
      }
      default:
        return out({});
    }
  };
}

let seq = 0;
function newRun(models?: Record<string, string>, jira = false): string {
  const runId = `RUN-${++seq}`;
  createRun({
    runId,
    label: runId,
    source: jira
      ? { kind: "jira", ticket: "PROJ-7", ticketUrl: "https://acme.atlassian.net/browse/PROJ-7" }
      : { kind: "manual", type: "feature", title: "Add widget", description: "d", acceptanceCriteria: ["a"] },
    repos: [{ path: repoPath, baseBranch: "master", aiGuidelinePath: null }],
    models,
  });
  return runId;
}

async function settle(runId: string, until: (s: RunState) => boolean): Promise<RunState> {
  for (let i = 0; i < 200; i++) {
    const s = loadRun(runId)!.state;
    if (until(s)) return s;
    if (s === "failed") throw new Error(`run failed: ${loadRun(runId)!.failureReason}`);
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`run ${runId} stuck in ${loadRun(runId)!.state}`);
}
const isGateOrEnd = (s: RunState) => s.startsWith("awaiting_") || s === "done" || s === "failed" || s === "paused";

beforeEach(() => {
  calls.length = 0;
  createPr.mockClear();
  mutableConfig.maxFixIterations = 3;
  mutableConfig.maxRunCostUsd = 0;
  mutableConfig.reviewAutoRoute = false;
  mkdirSync(repoPath, { recursive: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function driveToReviewGate(runId: string): Promise<void> {
  await workflow.startRun(runId);
  expect(await settle(runId, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
  await workflow.resumeAfterApproval(runId, "approve");
  expect(await settle(runId, isGateOrEnd)).toBe("awaiting_plan_approval");
  await workflow.resumeAfterApproval(runId, "approve");
  expect(await settle(runId, isGateOrEnd)).toBe("awaiting_branch_names");
  await workflow.resumeAfterApproval(runId, "approve");
}

describe("workflow state machine", () => {
  it("runs the full TDD pipeline from analyst to PR", async () => {
    const runId = newRun({ reviewer: "claude-opus-5-5" });
    script = happyScript(runId);
    await driveToReviewGate(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_pr_approval");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("done");

    expect(calls.map((c) => `${c.role}@${c.state}`)).toEqual([
      "analyst@analyst_running",
      "developer@developer_planning",
      "unitTester@unit_tests_red_running",
      "developer@developer_implementing",
      "unitTester@unit_tests_green_running",
      "integrationTester@integration_tester_running",
      "reviewer@reviewer_running",
      "e2eTester@e2e_tester_running",
      "prCreator@pr_creator_running",
    ]);
    // The PR payload from the approval reached `gh pr create`.
    expect(createPr).toHaveBeenCalledTimes(1);
    expect(createPr.mock.calls[0]![0]).toMatchObject({ body: "# Add widget\n\nbody", baseBranch: "master" });

    // Phase-specific prompts and per-role models.
    expect(calls.find((c) => c.state === "unit_tests_red_running")!.prompt).toContain("RED");
    expect(calls.find((c) => c.state === "unit_tests_green_running")!.prompt).toContain("GREEN");
    expect(calls.find((c) => c.role === "reviewer")!.model).toBe("claude-opus-5-5");
    expect(calls.find((c) => c.role === "developer")!.model).toBe(config.models.developer);

    // Cost is recorded per attempt.
    const rec = loadRun(runId)!;
    expect(rec.roles.analyst![0]!.costUsd).toBe(0.5);
    expect(rec.roles.unitTester).toHaveLength(2);
  });

  it("sends tester app-bugs back to the Developer and re-verifies", async () => {
    const runId = newRun();
    const base = happyScript(runId);
    let integrationRuns = 0;
    script = (role, state, args) => {
      if (role === "integrationTester" && integrationRuns++ === 0) {
        return out({ status: "blocked", handoff: { nextRole: "developer", notes: "POST /widgets returns 500" } });
      }
      return base(role, state, args);
    };
    await driveToReviewGate(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision");

    const seqAfterBranches = calls.slice(2).map((c) => `${c.role}@${c.state}`);
    expect(seqAfterBranches).toEqual([
      "unitTester@unit_tests_red_running",
      "developer@developer_implementing",
      "unitTester@unit_tests_green_running",
      "integrationTester@integration_tester_running",
      "developer@developer_implementing",
      "unitTester@unit_tests_green_running",
      "integrationTester@integration_tester_running",
      "reviewer@reviewer_running",
    ]);
    const fixPrompt = calls[6]!.prompt;
    expect(fixPrompt).toContain("Handed back by integrationTester");
    expect(fixPrompt).toContain("POST /widgets returns 500");
    expect(loadRun(runId)!.fixIterations).toBe(1);
  });

  it("pauses once the fix-loop cap is exceeded", async () => {
    mutableConfig.maxFixIterations = 1;
    const runId = newRun();
    const base = happyScript(runId);
    script = (role, state, args) =>
      role === "integrationTester"
        ? out({ status: "blocked", handoff: { nextRole: "developer", notes: "still broken" } })
        : base(role, state, args);
    await driveToReviewGate(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("paused");
    const rec = loadRun(runId)!;
    expect(rec.pauseReason).toMatch(/fix-loop limit reached \(1\)/);
    expect(calls.filter((c) => c.role === "integrationTester")).toHaveLength(2);

    // Jumping resets the counter and continues.
    script = base;
    await workflow.jumpToRole(runId, "integrationTester");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision");
    expect(loadRun(runId)!.fixIterations).toBe(0);
  });

  it("routes the review automatically from review-findings.json when enabled", async () => {
    mutableConfig.reviewAutoRoute = true;
    const runId = newRun();
    const base = happyScript(runId);
    let reviews = 0;
    script = (role, state, args) => {
      if (role === "reviewer") {
        const counts = reviews++ === 0 ? { blocker: 0, high: 1, med: 0, low: 0, nit: 0 } : { blocker: 0, high: 0, med: 2, low: 0, nit: 1 };
        mkdirSync(join(tmp, "runs", runId, "reviewer"), { recursive: true });
        writeFileSync(join(tmp, "runs", runId, "reviewer", "review-findings.json"), JSON.stringify(counts));
      }
      return base(role, state, args);
    };
    await driveToReviewGate(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_pr_approval");
    const roles = calls.slice(6).map((c) => c.role);
    // reviewer → (HIGH finding) developer → unit green → integration → reviewer → (clean) e2e → PR
    expect(roles).toEqual(["reviewer", "developer", "unitTester", "integrationTester", "reviewer", "e2eTester", "prCreator"]);
    expect(calls[7]!.prompt).toContain("review report attached above must be addressed");
  });

  it("aborting a running role pauses the run without failing it", async () => {
    const runId = newRun();
    script = (_role, _state, args) =>
      new Promise((_, reject) => args.signal!.addEventListener("abort", () => reject(new Error("aborted"))));
    await workflow.startRun(runId);
    await settle(runId, (s) => s === "analyst_running");
    await new Promise((r) => setTimeout(r, 10));
    workflow.abortRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("paused");
    await new Promise((r) => setTimeout(r, 10));
    const rec = loadRun(runId)!;
    expect(rec.state).toBe("paused");
    expect(rec.pauseReason).toBe("aborted by user");
    expect(rec.roles.analyst![0]!.status).toBe("aborted");
  });

  it("pauses before the next role once the cost budget is spent", async () => {
    mutableConfig.maxRunCostUsd = 0.4;
    const runId = newRun();
    script = happyScript(runId);
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("paused");
    expect(loadRun(runId)!.pauseReason).toMatch(/cost budget/);
    expect(calls).toHaveLength(1);
  });

  it("fails clearly when a role requests an approval it may not request", async () => {
    const runId = newRun();
    script = () => gate("create_pr");
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("failed");
    expect(loadRun(runId)!.failureReason).toMatch(/not allowed to request/);
  });

  it("pauses (not fails) when a role is blocked without a hand-off", async () => {
    const runId = newRun();
    script = () => out({ status: "blocked", handoff: null, approvalRequest: null });
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("paused");
  });
});

describe("JIRA MCP wiring", () => {
  const cfgFile = () => join(tmp, "jira-mcp.json");
  afterAll(() => rmSync(cfgFile(), { force: true }));

  it("gives JIRA read tools to the Analyst and issue access to the Developer on JIRA runs only", async () => {
    writeFileSync(cfgFile(), JSON.stringify({ serverName: "jira", server: { type: "http", url: "https://mcp.example.com/mcp" } }));
    const runId = newRun(undefined, true);
    script = happyScript(runId);
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_plan_approval");

    const [analyst, developer] = calls;
    expect(analyst!.mcpServers).toEqual(["jira"]);
    expect(analyst!.extraTools).toEqual([
      "mcp__jira__getJiraIssue",
      "mcp__jira__searchJiraIssuesUsingJql",
      "mcp__jira__getAccessibleAtlassianResources",
      "mcp__jira__atlassianUserInfo",
    ]);
    expect(analyst!.prompt).toContain("`mcp__jira__getJiraIssue`");
    expect(developer!.extraTools).toEqual(["mcp__jira__getJiraIssue"]);

    // Manual runs never get JIRA tools, even when JIRA is configured.
    calls.length = 0;
    const manual = newRun();
    script = happyScript(manual);
    await workflow.startRun(manual);
    await settle(manual, isGateOrEnd);
    expect(calls[0]!.extraTools).toEqual([]);
    expect(calls[0]!.mcpServers).toEqual([]);
  });

  it("fails a JIRA run clearly when no JIRA MCP server is configured", async () => {
    rmSync(cfgFile(), { force: true });
    const runId = newRun(undefined, true);
    script = happyScript(runId);
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("failed");
    expect(loadRun(runId)!.failureReason).toMatch(/no JIRA MCP server is configured/);
    expect(calls).toHaveLength(0);
  });
});

describe("state tables", () => {
  it("every running state maps to a role and back", () => {
    const running: RunState[] = [
      "analyst_running",
      "developer_planning",
      "developer_implementing",
      "unit_tests_red_running",
      "unit_tests_green_running",
      "integration_tester_running",
      "reviewer_running",
      "e2e_tester_running",
      "pr_creator_running",
    ];
    for (const s of running) {
      expect(workflow.roleForState(s)).not.toBeNull();
      expect(workflow.nextAfterDone(s)).not.toBeNull();
    }
    expect(workflow.roleForState("paused")).toBeNull();
  });

  it("never lets skip bypass branch creation", () => {
    expect(workflow.nextAfterSkip("awaiting_plan_approval")).toBeNull();
    expect(workflow.nextAfterSkip("awaiting_branch_names")).toBeNull();
  });
});
