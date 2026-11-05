import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoleOutput, RunState } from "../src/orchestrator/types.js";
import type { RunRoleAgentArgs, RunRoleAgentResult } from "../src/sdk/runRole.js";

/*
 * Drives the real state machine (workflow.ts + runStore + roles) with a
 * scripted fake of `runRoleAgent`, so no model is called. gh and JIRA are
 * mocked; git is real (a throwaway repo), so worktrees are really created.
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
      worktreesDir: join(tmp, "worktrees"),
    },
    config: {
      ...orig.config,
      maxFixIterations: 3,
      maxRunCostUsd: 0,
      reviewAutoRoute: false,
      maxConcurrentRoles: 0,
      worktree: { fetchBase: false, installDeps: true, copyFiles: [".env.test"] },
    },
  };
});

type Script = (role: string, state: RunState, args: RunRoleAgentArgs) => Promise<RunRoleAgentResult> | RunRoleAgentResult;
let script: Script;
const calls: Array<{
  runId: string;
  role: string;
  state: RunState;
  prompt: string;
  model: string;
  extraTools: string[];
  mcpServers: string[];
  cwd: string;
  repoPaths: string[];
  env: Record<string, string>;
}> = [];

vi.mock("../src/sdk/runRole.js", () => ({
  runRoleAgent: vi.fn(async (args: RunRoleAgentArgs) => {
    const { loadRun } = await import("../src/orchestrator/runStore.js");
    const state = loadRun(args.runId)!.state;
    calls.push({
      runId: args.runId,
      cwd: args.cwd,
      repoPaths: args.repoPaths,
      env: args.env ?? {},
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
vi.mock("../src/external/jiraMcp.js", () => ({ postJiraComment: vi.fn(async () => undefined) }));

const { config } = await import("../src/config.js");
const { createRun, loadRun } = await import("../src/orchestrator/runStore.js");
const workflow = await import("../src/orchestrator/workflow.js");

const mutableConfig = config as unknown as {
  maxFixIterations: number;
  maxRunCostUsd: number;
  reviewAutoRoute: boolean;
  maxConcurrentRoles: number;
};
const repoPath = join(tmp, "app");

// The orchestrator's own merges/rebases need a git identity on any machine.
Object.assign(process.env, { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
}

// A real repo on `main` with one commit and an untracked file to copy into worktrees.
mkdirSync(repoPath, { recursive: true });
git(repoPath, "init", "-q", "-b", "main");
writeFileSync(join(repoPath, "README.md"), "app\n");
git(repoPath, "add", ".");
git(repoPath, "commit", "-q", "-m", "init");
writeFileSync(join(repoPath, ".env.test"), "SECRET=1\n");

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
function newRun(models?: Record<string, string>, jira = false, label?: string): string {
  const runId = `RUN-${++seq}`;
  createRun({
    runId,
    label: label ?? runId,
    source: jira
      ? { kind: "jira", ticket: "PROJ-7", ticketUrl: "https://acme.atlassian.net/browse/PROJ-7" }
      : { kind: "manual", type: "feature", title: "Add widget", description: "d", acceptanceCriteria: ["a"] },
    repos: [{ path: repoPath, baseBranch: "main", aiGuidelinePath: null }],
    models,
  });
  return runId;
}

async function settle(runId: string, until: (s: RunState) => boolean): Promise<RunState> {
  for (let i = 0; i < 1000; i++) {
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
  mutableConfig.maxConcurrentRoles = 0;
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
    expect(createPr.mock.calls[0]![0]).toMatchObject({ body: "# Add widget\n\nbody", baseBranch: "main" });

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

describe("parallel runs", () => {
  const wt = (runId: string) => join(tmp, "worktrees", runId, "app");

  async function toBranchGate(runId: string): Promise<void> {
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_plan_approval");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_branch_names");
  }

  it("gives each run its own worktree and never touches the user's checkout", async () => {
    const a = newRun();
    const b = newRun();
    script = (role, state, args) => happyScript(args.runId)(role, state, args);
    await Promise.all([toBranchGate(a), toBranchGate(b)]);

    // Analyst works in its run folder; every repo-facing role in the run's worktree.
    for (const runId of [a, b]) {
      const dev = calls.find((c) => c.runId === runId && c.role === "developer")!;
      expect(dev.cwd).toBe(wt(runId));
      expect(dev.repoPaths).toEqual([wt(runId)]);
      expect(dev.prompt).toContain("this run's own git worktree");
      expect(existsSync(join(wt(runId), ".env.test"))).toBe(true); // WORKTREE_COPY_FILES
      expect(git(wt(runId), "status", "--porcelain")).toBe("?? .env.test");
    }

    await Promise.all([workflow.resumeAfterApproval(a, "approve"), workflow.resumeAfterApproval(b, "approve")]);
    expect(await settle(a, isGateOrEnd)).toBe("awaiting_review_decision");
    expect(await settle(b, isGateOrEnd)).toBe("awaiting_review_decision");

    const branchA = loadRun(a)!.repos[0]!.branch!;
    const branchB = loadRun(b)!.repos[0]!.branch!;
    expect(branchA).not.toBe(branchB);
    expect(git(wt(a), "branch", "--show-current")).toBe(branchA);
    expect(git(wt(b), "branch", "--show-current")).toBe(branchB);
    // The user's checkout stays on main, untouched.
    expect(git(repoPath, "branch", "--show-current")).toBe("main");
    expect(git(repoPath, "status", "--porcelain")).toBe("?? .env.test");

    const reviewer = calls.find((c) => c.runId === a && c.role === "reviewer")!;
    expect(reviewer.prompt).toContain(`\`${wt(a)}\`: \`git diff main...HEAD\``);
  });

  it("suggests a run-specific branch when the templated name is taken, and re-opens the gate on conflicts", async () => {
    const a = newRun(undefined, false, "PROJ-9");
    const b = newRun(undefined, false, "PROJ-9"); // same ticket → same templated name
    script = (role, state, args) => happyScript(args.runId)(role, state, args);
    await toBranchGate(a);
    await workflow.resumeAfterApproval(a, "approve");
    await settle(a, isGateOrEnd);
    const taken = loadRun(a)!.repos[0]!.branch!;

    await toBranchGate(b);
    const proposal = JSON.parse(readFileSync(join(tmp, "runs", b, "orchestrator", "proposed-branches.json"), "utf8"));
    expect(proposal.perRepo[0].suggestedBranch).toBe(`${taken}-${b.split("-").pop()!.toLowerCase()}`);
    expect(proposal.perRepo[0].note).toContain(`run ${a}`);

    // Forcing the taken name keeps the gate open with an explanation instead of failing the run.
    const edited = JSON.stringify({ perRepo: [{ ...proposal.perRepo[0], suggestedBranch: taken }] });
    await workflow.resumeAfterApproval(b, "edit", edited);
    const rec = loadRun(b)!;
    expect(rec.state).toBe("awaiting_branch_names");
    expect(rec.pendingApproval?.summary).toMatch(/already checked out in run RUN-\d+/);
    expect(git(wt(b), "branch", "--show-current")).toBe(""); // still detached

    // The gate keeps the user's (conflicting) name for editing; approving a free name proceeds.
    const kept = JSON.parse(readFileSync(join(tmp, "runs", b, "orchestrator", "proposed-branches.json"), "utf8"));
    expect(kept.perRepo[0].suggestedBranch).toBe(taken);
    await workflow.resumeAfterApproval(b, "edit", JSON.stringify(proposal));
    expect(await settle(b, isGateOrEnd)).toBe("awaiting_review_decision");
    expect(loadRun(b)!.repos[0]!.branch).toBe(proposal.perRepo[0].suggestedBranch);
  });

  it("queues roles beyond MAX_CONCURRENT_ROLES across runs, first come first served", async () => {
    mutableConfig.maxConcurrentRoles = 1;
    const a = newRun();
    const b = newRun();
    let finishA!: () => void;
    const aBlocked = new Promise<void>((r) => (finishA = r));
    script = async (role, state, args) => {
      if (args.runId === a) await aBlocked;
      return happyScript(args.runId)(role, state, args);
    };
    await workflow.startRun(a);
    await workflow.startRun(b);
    await new Promise((r) => setTimeout(r, 30));

    expect(workflow.roleSlots.running).toBe(1);
    expect(workflow.roleSlots.queued).toBe(1);
    expect(loadRun(b)!.roles.analyst![0]!.status).toBe("queued");
    expect(calls.map((c) => c.runId)).toEqual([a]);

    finishA();
    expect(await settle(a, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    expect(await settle(b, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    expect(calls.map((c) => c.runId)).toEqual([a, b]);
    expect(workflow.roleSlots.running).toBe(0);
  });

  it("aborting a queued role frees its place without running it", async () => {
    mutableConfig.maxConcurrentRoles = 1;
    const a = newRun();
    const b = newRun();
    let finishA!: () => void;
    const aBlocked = new Promise<void>((r) => (finishA = r));
    script = async (role, state, args) => {
      await aBlocked;
      return happyScript(args.runId)(role, state, args);
    };
    await workflow.startRun(a);
    await workflow.startRun(b);
    await new Promise((r) => setTimeout(r, 30));
    workflow.abortRun(b);
    await new Promise((r) => setTimeout(r, 10));
    expect(workflow.roleSlots.queued).toBe(0);
    expect(loadRun(b)!.state).toBe("paused");
    expect(loadRun(b)!.roles.analyst![0]!.status).toBe("aborted");
    finishA();
    await settle(a, isGateOrEnd);
    expect(calls.filter((c) => c.runId === b)).toHaveLength(0);
  });

  it("removes a finished run's worktree and re-creates it on the branch if the run continues", async () => {
    const runId = newRun();
    script = happyScript(runId);
    await toBranchGate(runId);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd);
    const branch = loadRun(runId)!.repos[0]!.branch!;

    await expect(workflow.removeRunWorkspaces(runId, false)).rejects.toThrow(/done, failed or paused/);
    workflow.abortRun(runId); // → paused
    // Uncommitted work blocks removal unless forced.
    writeFileSync(join(wt(runId), "wip.txt"), "x");
    const kept = await workflow.removeRunWorkspaces(runId, false);
    expect(kept[0]!.removed).toBe(false);
    expect(existsSync(wt(runId))).toBe(true);
    const removed = await workflow.removeRunWorkspaces(runId, true);
    expect(removed[0]!.removed).toBe(true);
    expect(existsSync(wt(runId))).toBe(false);
    expect(loadRun(runId)!.repos[0]!.workPath).toBeNull();
    expect(git(repoPath, "branch", "--list", branch)).toContain(branch);

    await workflow.jumpToRole(runId, "reviewer");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision");
    expect(git(wt(runId), "branch", "--show-current")).toBe(branch);
  });

  it("keeps pre-worktree runs working in the user's checkout", async () => {
    const runId = newRun();
    loadRun(runId)!.workspace = "in-place";
    script = happyScript(runId);
    await workflow.startRun(runId);
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd);
    expect(calls.find((c) => c.role === "developer")!.cwd).toBe(repoPath);
    expect(existsSync(join(tmp, "worktrees", runId))).toBe(false);
  });
});

describe("parallel runs: ports, overlaps, sync before PR", () => {
  const wt = (runId: string) => join(tmp, "worktrees", runId, "app");
  const happy: Script = (role, state, args) => happyScript(args.runId)(role, state, args);

  async function toBranchGate(runId: string): Promise<void> {
    await workflow.startRun(runId);
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_branch_names");
  }

  it("reserves a distinct port block per run and passes it to role sessions", async () => {
    const a = newRun();
    const b = newRun();
    script = happy;
    await Promise.all([toBranchGate(a), toBranchGate(b)]);
    const pa = loadRun(a)!.ports!;
    const pb = loadRun(b)!.ports!;
    expect(pa.count).toBe(config.ports.blockSize);
    expect(pa.base).not.toBe(pb.base);
    const dev = calls.find((c) => c.runId === a && c.role === "developer")!;
    expect(dev.env).toMatchObject({ ORCH_RUN_ID: a, PORT: String(pa.base), E2E_BASE_URL: `http://localhost:${pa.base}` });
    expect(dev.prompt).toContain(`Ports reserved for this run: ${pa.base}–${pa.base + pa.count - 1}`);
    // The Analyst runs before any worktree exists, so it has no ports yet.
    expect(calls.find((c) => c.runId === a && c.role === "analyst")!.env).toEqual({ ORCH_RUN_ID: a });

    workflow.abortRun(a);
    await workflow.removeRunWorkspaces(a, true);
    expect(loadRun(a)!.ports).toBeNull();
  });

  it("flags files changed by two active runs on both runs", async () => {
    const a = newRun();
    const b = newRun();
    // Each Developer edits README.md (shared) plus its own file.
    script = (role, state, args) => {
      if (role === "developer" && state === "developer_implementing") {
        writeFileSync(join(args.cwd, "README.md"), `changed by ${args.runId}\n`);
        writeFileSync(join(args.cwd, `${args.runId}.txt`), "x\n");
      }
      return happy(role, state, args);
    };
    await Promise.all([toBranchGate(a), toBranchGate(b)]);
    await Promise.all([workflow.resumeAfterApproval(a, "approve"), workflow.resumeAfterApproval(b, "approve")]);
    await settle(a, isGateOrEnd);
    await settle(b, isGateOrEnd);
    // Refreshes also run in the background after each role; await one to avoid timing flakes.
    const { refreshOverlaps } = await import("../src/orchestrator/overlaps.js");
    await refreshOverlaps(loadRun(a)!);

    expect(loadRun(a)!.overlaps).toEqual([{ otherRunId: b, otherLabel: b, repoPath, files: ["README.md"] }]);
    expect(loadRun(b)!.overlaps).toEqual([{ otherRunId: a, otherLabel: a, repoPath, files: ["README.md"] }]);

    // Once one run's worktree is gone, neither run reports the overlap.
    workflow.abortRun(b);
    await workflow.removeRunWorkspaces(b, true);
    expect(loadRun(a)!.overlaps).toEqual([]);
  });

  it("rebases onto new upstream commits before the PR Creator and tells it so", async () => {
    const runId = newRun();
    script = (role, state, args) => {
      if (role === "developer" && state === "developer_implementing") {
        writeFileSync(join(args.cwd, `${runId}.txt`), "feature\n");
        git(args.cwd, "add", ".");
        git(args.cwd, "commit", "-qm", "feature");
        // Meanwhile someone lands a change on main.
        writeFileSync(join(repoPath, `upstream-${runId}.txt`), "u\n");
        git(repoPath, "add", `upstream-${runId}.txt`);
        git(repoPath, "commit", "-qm", "upstream");
      }
      return happy(role, state, args);
    };
    await toBranchGate(runId);
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision");
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_pr_approval");

    const pr = calls.find((c) => c.runId === runId && c.role === "prCreator")!;
    expect(pr.prompt).toContain("## Orchestrator notes");
    expect(pr.prompt).toMatch(/was rebased onto `main` \(1 new upstream commit/);
    expect(git(wt(runId), "log", "-1", "--format=%s", "HEAD~1")).toBe("upstream");
  });

  it("sends merge conflicts with the base back to the Developer, then re-verifies before the PR", async () => {
    const runId = newRun();
    const shared = `conflict-${runId}.txt`;
    writeFileSync(join(repoPath, shared), "base\n");
    git(repoPath, "add", shared);
    git(repoPath, "commit", "-qm", "add shared file");

    let devRuns = 0;
    script = (role, state, args) => {
      if (role === "developer" && state === "developer_implementing") {
        devRuns++;
        if (devRuns === 1) {
          writeFileSync(join(args.cwd, shared), "feature\n");
          git(args.cwd, "commit", "-qam", "feature edit");
          writeFileSync(join(repoPath, shared), "upstream\n");
          git(repoPath, "commit", "-qam", "upstream edit");
        } else {
          // Resolve and conclude the merge the orchestrator left in progress.
          expect(readFileSync(join(args.cwd, shared), "utf8")).toContain("<<<<<<<");
          writeFileSync(join(args.cwd, shared), "feature + upstream\n");
          git(args.cwd, "add", shared);
          git(args.cwd, "commit", "--no-edit", "-q");
        }
      }
      return happy(role, state, args);
    };
    await toBranchGate(runId);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd); // review gate
    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_review_decision"); // back through verification
    expect(devRuns).toBe(2);
    const fix = calls.filter((c) => c.runId === runId && c.role === "developer")[2]!;
    expect(fix.prompt).toContain("git reported **conflicts**");
    expect(fix.prompt).toContain(`\`${shared}\``);
    expect(loadRun(runId)!.fixIterations).toBe(1);

    await workflow.resumeAfterApproval(runId, "approve");
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_pr_approval");
    expect(readFileSync(join(wt(runId), shared), "utf8")).toBe("feature + upstream\n");
  });

  it("replays the persisted event stream with sequence numbers", async () => {
    const runId = newRun();
    script = happy;
    await workflow.startRun(runId);
    await settle(runId, isGateOrEnd);
    const { readEventLog } = await import("../src/events.js");
    const log = readEventLog(runId);
    expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
    expect(log.map((e) => e.type)).toEqual(
      expect.arrayContaining(["run.transitioned", "role.started", "role.ended", "approval.requested"]),
    );
  });
});

describe("housekeeping", () => {
  async function finishedRun(): Promise<string> {
    const runId = newRun();
    script = happyScript(runId);
    await workflow.startRun(runId);
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve");
    await settle(runId, isGateOrEnd);
    await workflow.resumeAfterApproval(runId, "approve"); // branch
    await settle(runId, isGateOrEnd);
    workflow.abortRun(runId); // → paused, with a worktree and a port block
    return runId;
  }

  it("archives a run: worktree and sessions gone, artifacts and history kept, port freed", async () => {
    const runId = await finishedRun();
    const wtPath = loadRun(runId)!.repos[0]!.workPath!;
    const branch = loadRun(runId)!.repos[0]!.branch!;
    mkdirSync(join(tmp, "sessions", runId), { recursive: true });
    await workflow.removeRun(runId, "archive", false);

    expect(existsSync(wtPath)).toBe(false);
    expect(existsSync(join(tmp, "runs", runId))).toBe(false);
    expect(existsSync(join(tmp, "sessions", runId))).toBe(false);
    expect(existsSync(join(tmp, "runs", ".archive", runId, "run.json"))).toBe(true);
    expect(existsSync(join(tmp, "runs", ".archive", runId, "events.jsonl"))).toBe(true);
    expect(loadRun(runId)).toBeNull();
    expect(git(repoPath, "branch", "--list", branch)).toContain(branch); // branch kept

    const { listArchivedRuns, listRuns } = await import("../src/orchestrator/runStore.js");
    expect(listRuns().some((r) => r.runId === runId)).toBe(false);
    const archived = listArchivedRuns().find((r) => r.runId === runId)!;
    expect(archived.archived).toBe(true);
    expect(archived.ports).toBeNull();
  });

  it("deletes a run, refusing dirty worktrees unless forced", async () => {
    const runId = await finishedRun();
    const wtPath = loadRun(runId)!.repos[0]!.workPath!;
    writeFileSync(join(wtPath, "wip.txt"), "x");
    await expect(workflow.removeRun(runId, "delete", false)).rejects.toThrow(/uncommitted changes/);
    expect(existsSync(join(tmp, "runs", runId))).toBe(true);
    await workflow.removeRun(runId, "delete", true);
    expect(existsSync(join(tmp, "runs", runId))).toBe(false);
    expect(existsSync(wtPath)).toBe(false);
  });

  it("refuses to remove a run that is still in progress", async () => {
    const runId = newRun();
    script = happyScript(runId);
    await workflow.startRun(runId);
    expect(await settle(runId, isGateOrEnd)).toBe("awaiting_feature_doc_approval");
    await expect(workflow.removeRun(runId, "archive", false)).rejects.toThrow(/only done, failed, paused or unstarted/);
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
