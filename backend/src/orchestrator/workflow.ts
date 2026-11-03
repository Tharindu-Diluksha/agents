import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, paths } from "../config.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { runRoleAgent } from "../sdk/runRole.js";
import { roles as roleRegistry } from "../roles/index.js";
import { planApproved } from "../roles/developer.js";
import { readReviewFindings } from "../roles/reviewer.js";
import type { RoleInputCtx, RoleSpec } from "../roles/types.js";
import { jiraToolsFor, loadJiraMcpConfig, mcpServersOption } from "../external/jiraMcpConfig.js";
import { postJiraComment } from "../external/jiraMcp.js";
import { createPr } from "../external/gh.js";
import { clearApproval, requestApproval } from "./approvals.js";
import { artifactPath, perRepoPrDescriptionName, readArtifact, runDir, toRelative } from "./artifacts.js";
import { Semaphore } from "./concurrency.js";
import { runEnv } from "./ports.js";
import { refreshOverlaps } from "./overlaps.js";
import { syncWithBase } from "../external/git.js";
import { prepareWorkspaces, removeWorkspaces, setFeatureBranch, usesWorktrees, workDir, type RemoveResult } from "./workspaces.js";
import { proposeBranches, readProposedBranches, writeProposedBranches, type BranchProposal } from "./branches.js";
import { latestAttempt, loadRun, saveRun, startAttempt, totalCostUsd, transition } from "./runStore.js";
import type { ApprovalAction, PendingApproval, RoleAttempt, RoleId, RoleOutput, RunRecord, RunState } from "./types.js";

/*
 * Pipeline:
 *
 *   analyst → [feature doc / JIRA comment gate]
 *   → developer (planning) → [plan gate] → [branch-name gate]
 *   → unitTester (RED: failing tests) → developer (implementing)
 *   → unitTester (GREEN: verify) → integrationTester
 *   → reviewer → [review gate]
 *   → e2eTester (→ [suite-creation gate]) → prCreator → [PR gate] → done
 *
 * Fix loops: any tester that finds an app-bug, or a review sent back for
 * fixes, returns to developer (implementing), after which the change goes
 * through unit GREEN → integration → review → e2e again. Each loop counts
 * toward `config.maxFixIterations`; past the cap the run pauses.
 */

const inFlight = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Public entry points (called from routes and recovery)
// ---------------------------------------------------------------------------

export async function startRun(runId: string): Promise<void> {
  const record = mustLoad(runId);
  if (record.state !== "created") {
    throw new Error(`run ${runId} already started (state=${record.state})`);
  }
  startRole(record, "analyst", "manual launch");
}

export async function resumeAfterApproval(
  runId: string,
  decision: "approve" | "reject" | "edit" | "skip",
  editedPayload?: string,
  feedback?: string,
): Promise<void> {
  const record = mustLoad(runId);
  const pending = record.pendingApproval;
  if (!pending) throw new Error(`run ${runId} has no pending approval`);

  emit({ type: "approval.resolved", runId, role: pending.role, action: pending.action, decision });

  const prevState = record.state;
  clearApproval(record);
  saveRun(record);

  const resolver = approvalResolvers[pending.action];
  if (!resolver) {
    fail(record, `no handler for approval action ${pending.action}`);
    return;
  }
  await resolver(record, decision, { editedPayload, feedback, prevState, pending });
}

/**
 * Manually (re)start a role. Aborts whatever is running, resets the fix-loop
 * counter, and bypasses the cost budget for this one role — the user has
 * looked at the run and chosen to continue.
 */
export async function jumpToRole(runId: string, role: RoleId): Promise<void> {
  const record = mustLoad(runId);
  stopInFlight(runId);
  clearApproval(record);
  record.fixIterations = 0;
  record.pauseReason = undefined;
  record.failureReason = undefined;
  startRole(record, role, `jump to ${role}`, {}, { ignoreBudget: true });
}

export async function skipCurrent(runId: string): Promise<void> {
  const record = mustLoad(runId);
  const next = nextAfterSkip(record.state);
  if (!next) throw new Error(`cannot skip from ${record.state}`);
  clearApproval(record);
  if (next === "done") {
    goTo(record, "done", "skip");
    return;
  }
  startRole(record, next, "skip");
}

/** Stops the running role (if any) and pauses the run. Resume with jumpToRole. */
export function abortRun(runId: string): void {
  const record = loadRun(runId);
  stopInFlight(runId);
  if (!record || record.state === "done" || record.state === "failed" || record.state === "paused") return;
  clearApproval(record);
  pause(record, "aborted by user");
}

/**
 * Removes the run's worktrees (the branches stay). Only for finished, failed
 * or paused runs; if the run is resumed later, the worktree is re-created on
 * its branch. Without `force`, a worktree with uncommitted changes is kept and
 * reported.
 */
export async function removeRunWorkspaces(runId: string, force: boolean): Promise<RemoveResult[]> {
  const record = mustLoad(runId);
  if (inFlight.has(runId)) throw new Error("a role is still running in this run; abort it first");
  if (!["done", "failed", "paused"].includes(record.state)) {
    throw new Error(`worktrees can only be removed when the run is done, failed or paused (state: ${record.state})`);
  }
  const results = await removeWorkspaces(record, force);
  saveRun(record);
  await refreshOverlaps(record);
  for (const r of results) {
    log.info("workflow.worktree_removed", { runId, repo: r.repoPath, workPath: r.workPath, removed: r.removed, err: r.error });
  }
  return results;
}

/** Re-entry used by startup recovery: re-issues the role for the current state. */
export async function runRoleViaWorkflow(record: RunRecord, role: RoleId, ctx: RoleInputCtx = {}): Promise<void> {
  await runRoleAsync(record, role, ctx);
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function mustLoad(runId: string): RunRecord {
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  return record;
}

function stopInFlight(runId: string): void {
  const ctrl = inFlight.get(runId);
  if (ctrl) {
    ctrl.abort();
    inFlight.delete(runId);
  }
}

function goTo(record: RunRecord, to: RunState, reason: string): void {
  const from = record.state;
  transition(record, to, reason);
  saveRun(record);
  emit({ type: "run.transitioned", runId: record.runId, from, to });
}

function fail(record: RunRecord, reason: string): void {
  record.failureReason = reason;
  transition(record, "failed", reason);
  saveRun(record);
  emit({ type: "run.failed", runId: record.runId, error: reason });
}

function pause(record: RunRecord, reason: string): void {
  record.pauseReason = reason;
  goTo(record, "paused", reason);
  emit({ type: "role.message", runId: record.runId, role: currentOrLastRole(record), subtype: "system", text: `[orchestrator] run paused: ${reason}` });
}

function currentOrLastRole(record: RunRecord): RoleId {
  let last: { role: RoleId; at: string } | null = null;
  for (const [role, attempts] of Object.entries(record.roles) as Array<[RoleId, RunRecord["roles"][RoleId]]>) {
    const a = attempts?.[attempts.length - 1];
    if (a && (!last || a.startedAt > last.at)) last = { role, at: a.startedAt };
  }
  return last?.role ?? "analyst";
}

/** The running state a role enters when (re)started. */
export function runningStateFor(record: RunRecord, role: RoleId): RunState {
  switch (role) {
    case "analyst":
      return "analyst_running";
    case "developer":
      return planApproved(record) ? "developer_implementing" : "developer_planning";
    case "unitTester":
      // The first Unit Tester run writes failing tests (RED); every later run verifies (GREEN).
      return latestAttempt(record, "unitTester") ? "unit_tests_green_running" : "unit_tests_red_running";
    case "integrationTester":
      return "integration_tester_running";
    case "reviewer":
      return "reviewer_running";
    case "e2eTester":
      return "e2e_tester_running";
    case "prCreator":
      return "pr_creator_running";
  }
}

/** Role that owns a running state, or null for gates / terminal states. */
export function roleForState(state: RunState): RoleId | null {
  switch (state) {
    case "analyst_running":
      return "analyst";
    case "developer_planning":
    case "developer_implementing":
      return "developer";
    case "unit_tests_red_running":
    case "unit_tests_green_running":
      return "unitTester";
    case "integration_tester_running":
      return "integrationTester";
    case "reviewer_running":
      return "reviewer";
    case "e2e_tester_running":
      return "e2eTester";
    case "pr_creator_running":
      return "prCreator";
    default:
      return null;
  }
}

/** Where the run goes when a role in `state` reports `done`. */
export function nextAfterDone(state: RunState): RunState | "plan_gate" | "complete" | null {
  switch (state) {
    case "analyst_running":
      return "developer_planning";
    case "developer_planning":
      // The plan must always be approved before branches are created.
      return "plan_gate";
    case "unit_tests_red_running":
      return "developer_implementing";
    case "developer_implementing":
      return "unit_tests_green_running";
    case "unit_tests_green_running":
      return "integration_tester_running";
    case "integration_tester_running":
      return "reviewer_running";
    case "reviewer_running":
      return "e2e_tester_running";
    case "e2e_tester_running":
      return "pr_creator_running";
    case "pr_creator_running":
      return "complete";
    default:
      return null;
  }
}

export function nextAfterSkip(state: RunState): RunState | null {
  switch (state) {
    case "awaiting_feature_doc_approval":
    case "awaiting_jira_comment_decision":
      return "developer_planning";
    case "awaiting_plan_approval":
      // Skipping the plan gate would skip branch creation — the Developer might
      // commit to the base branch. Approve the plan instead.
      return null;
    case "awaiting_branch_names":
      return null;
    case "awaiting_review_decision":
      return "e2e_tester_running";
    case "awaiting_test_suite_approval":
      return "pr_creator_running";
    case "awaiting_pr_approval":
      return "done";
    default:
      return null;
  }
}

export function gateStateFor(role: RoleId, action: ApprovalAction): RunState | null {
  if (role === "analyst" && action === "post_jira_comment") return "awaiting_jira_comment_decision";
  if (role === "analyst" && action === "proceed_to_next") return "awaiting_feature_doc_approval";
  if (role === "developer" && action === "proceed_to_next") return "awaiting_plan_approval";
  if (role === "reviewer" && action === "proceed_to_next") return "awaiting_review_decision";
  if (role === "e2eTester" && action === "create_test_suite") return "awaiting_test_suite_approval";
  if (role === "prCreator" && action === "create_pr") return "awaiting_pr_approval";
  return null;
}

/** Transition into the role's running state and start it. */
function startRole(
  record: RunRecord,
  roleOrState: RoleId | RunState,
  reason: string,
  ctx: RoleInputCtx = {},
  opts: { ignoreBudget?: boolean } = {},
): void {
  const role = (roleOrState in roleRegistry ? roleOrState : roleForState(roleOrState as RunState)) as RoleId | null;
  if (!role) {
    fail(record, `no role runs in state ${roleOrState}`);
    return;
  }
  const state = roleOrState in roleRegistry ? runningStateFor(record, role) : (roleOrState as RunState);
  goTo(record, state, reason);
  if (role === "prCreator" && usesWorktrees(record) && config.syncBaseBeforePr) {
    void syncThenStartPrCreator(record, ctx, opts);
    return;
  }
  void runRoleAsync(record, role, ctx, opts);
}

/**
 * Before the PR Creator: bring each repo's branch up to date with its base
 * (rebase if never pushed, merge otherwise). Conflicts go back to the
 * Developer (a fix loop) with the merge left in progress; the change then
 * goes through verification again before returning here.
 */
async function syncThenStartPrCreator(record: RunRecord, ctx: RoleInputCtx, opts: { ignoreBudget?: boolean }): Promise<void> {
  const notes: string[] = [];
  const conflicts: string[] = [];
  for (const repo of record.repos) {
    if (!repo.workPath || !repo.branch) continue;
    const where = `\`${repo.workPath}\` (${repo.branch})`;
    try {
      const r = await syncWithBase(repo.workPath, repo.baseBranch, { fetch: config.worktree.fetchBase });
      if (r.ref) repo.baseRef = r.ref;
      if (r.status === "rebased" || r.status === "merged") {
        notes.push(
          `${where} was ${r.status} onto \`${r.ref}\` (${r.behind} new upstream commit(s)). The test reports predate this; say so in the PR's test plan.`,
        );
      } else if (r.status === "conflicts") {
        conflicts.push(`- ${where}, merging \`${r.ref}\`: ${r.files.map((f) => `\`${f}\``).join(", ")}`);
      } else if (r.status === "skipped") {
        notes.push(`${where} could not be synced with \`${repo.baseBranch}\`: ${r.reason}. The PR may need a rebase.`);
      }
    } catch (err) {
      notes.push(`${where} could not be synced with \`${repo.baseBranch}\`: ${errMsg(err)}. The PR may need a rebase.`);
    }
  }
  saveRun(record);
  // The user may have aborted or jumped elsewhere meanwhile.
  if (record.state !== "pr_creator_running") return;
  for (const n of notes) systemMessage(record, "prCreator", n);

  if (conflicts.length > 0) {
    systemMessage(record, "prCreator", `merge conflicts with the latest base:\n${conflicts.join("\n")}`);
    if (!admitFixLoop(record, "merge conflicts with the latest base")) return;
    startRole(record, "developer_implementing", "merge conflicts with the latest base", {
      signal: "merge_conflicts",
      notes: conflicts,
    });
    return;
  }
  void refreshOverlaps(record);
  await runRoleAsync(record, "prCreator", { ...ctx, notes: [...(ctx.notes ?? []), ...notes] }, opts);
}

/**
 * Counts a fix loop and returns false (after pausing the run) once the
 * configured cap is exceeded.
 */
function admitFixLoop(record: RunRecord, why: string): boolean {
  record.fixIterations = (record.fixIterations ?? 0) + 1;
  const max = config.maxFixIterations;
  if (max > 0 && record.fixIterations > max) {
    pause(
      record,
      `fix-loop limit reached (${max}) — last trigger: ${why}. Review the reports, then use "Jump" to continue (this resets the counter).`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Approval resolvers
// ---------------------------------------------------------------------------

type ApprovalResolverCtx = {
  editedPayload?: string;
  feedback?: string;
  prevState: RunState;
  /** The approval being resolved (already cleared from the record). */
  pending: PendingApproval;
};

type Decision = "approve" | "reject" | "edit" | "skip";

const approvalResolvers: Record<ApprovalAction, (record: RunRecord, decision: Decision, ctx: ApprovalResolverCtx) => Promise<void>> = {
  async proceed_to_next(record, decision, ctx) {
    const approved = decision === "approve" || decision === "edit";
    switch (ctx.prevState) {
      case "awaiting_feature_doc_approval":
        if (approved) startRole(record, "developer_planning", "feature doc approved");
        else startRole(record, "analyst_running", "feature doc rejected", { feedback: ctx.feedback });
        return;
      case "awaiting_plan_approval":
        if (approved) await enterBranchNamesGate(record);
        else startRole(record, "developer_planning", "plan rejected", { feedback: ctx.feedback });
        return;
      case "awaiting_review_decision":
        if (approved) {
          startRole(record, "e2e_tester_running", "review passed");
        } else if (admitFixLoop(record, "review sent back for fixes")) {
          startRole(record, "developer_implementing", "review fixes required", {
            signal: "review_fixes_required",
            feedback: ctx.feedback,
          });
        }
        return;
      default:
        fail(record, `proceed_to_next approval arrived in unexpected state ${ctx.prevState}`);
    }
  },

  async approve_branch_names(record, decision, ctx) {
    if (decision !== "approve" && decision !== "edit") {
      // reject / skip both abort the whole run — the Developer can't commit without branches.
      fail(
        record,
        decision === "skip"
          ? "branch creation skipped; run cannot continue without a feature branch per repo"
          : "branch names rejected; run cancelled",
      );
      return;
    }

    const proposals = parseEditedBranches(record, ctx.editedPayload) ?? readProposedBranches(record.runId);
    if (!proposals || proposals.length === 0) {
      fail(record, "no branch proposals found for this run");
      return;
    }

    // Worktrees normally exist since Developer planning; re-create them if they were removed.
    try {
      await prepareWorkspaces(record, (m) => systemMessage(record, "developer", m));
      saveRun(record);
    } catch (err) {
      fail(record, `could not prepare workspaces: ${errMsg(err)}`);
      return;
    }

    const results: Array<{ repoPath: string; branch: string; outcome?: string; error?: string }> = [];
    for (const p of proposals) {
      const repo = record.repos.find((r) => r.path === p.repoPath);
      if (!repo) continue;
      try {
        const outcome = await setFeatureBranch(record, repo, p.suggestedBranch);
        log.info("workflow.branch_ready", { runId: record.runId, repo: p.repoPath, branch: p.suggestedBranch, outcome });
        results.push({ repoPath: p.repoPath, branch: p.suggestedBranch, outcome });
      } catch (err) {
        const msg = errMsg(err);
        log.error("workflow.branch_failed", { runId: record.runId, repo: p.repoPath, branch: p.suggestedBranch, err: msg });
        results.push({ repoPath: p.repoPath, branch: p.suggestedBranch, error: msg });
      }
    }
    saveRun(record);

    if (results.some((r) => r.error)) {
      // Keep the gate open with the user's names so they can pick others and retry.
      const payload = writeProposedBranches(record.runId, proposals);
      reopenGate(
        record,
        "developer",
        "approve_branch_names",
        `Branch setup failed — edit the names and approve again:\n${results
          .map((r) => (r.error ? `${r.repoPath} (${r.branch}): ${r.error}` : `${r.repoPath}: ${r.branch} ${r.outcome}`))
          .join("\n")}`,
        [payload],
      );
      return;
    }

    emit({
      type: "role.message",
      runId: record.runId,
      role: "developer",
      subtype: "system",
      text: `[orchestrator] prepared ${results.length} branch(es):\n${results
        .map((r) => `- ${r.repoPath}: ${r.branch} (${r.outcome})`)
        .join("\n")}`,
    });

    startRole(record, "unit_tests_red_running", "branches ready; writing failing unit tests");
  },

  async post_jira_comment(record, decision, ctx) {
    if (decision === "approve" || decision === "edit") {
      if (record.source.kind !== "jira") {
        log.warn("workflow.jira_comment_skipped_manual_source", { runId: record.runId });
      } else {
        const path = artifactPath(record, "analyst", "proposed-jira-comment.md");
        const body = ctx.editedPayload ?? readArtifact(path) ?? "";
        try {
          await postJiraComment(record.source.ticket, body);
          log.info("workflow.jira_comment_posted", { runId: record.runId, ticket: record.source.ticket });
        } catch (err) {
          // Keep the gate open so the user sees the failure and can retry, edit, or skip.
          const msg = errMsg(err);
          log.error("workflow.jira_comment_failed", { runId: record.runId, err: msg });
          reopenGate(record, "analyst", "post_jira_comment", `Posting the JIRA comment failed: ${msg}. Retry, edit, or skip.`, [
            toRelative(path),
          ]);
          return;
        }
      }
    }
    startRole(record, "developer_planning", "JIRA comment resolved");
  },

  async create_test_suite(record, decision) {
    if (decision === "approve" || decision === "edit") {
      startRole(record, "e2e_tester_running", "test suite creation approved", { signal: "create_suite_approved" });
    } else {
      // No suite wanted (e.g. no user-facing surface): skip E2E and move on.
      startRole(record, "pr_creator_running", "E2E suite creation declined; skipping E2E tests");
    }
  },

  async create_pr(record, decision, ctx) {
    if (decision !== "approve") {
      startRole(record, "pr_creator_running", "PR descriptions rejected", { feedback: ctx.feedback });
      return;
    }

    const payloadPaths = ctx.pending.payloadPaths;
    // One PR per repo, matched by the `<repoSlug>-pr-description.md` filename.
    // A single-repo run falls back to the only payload.
    const results: Array<{ repoPath: string; url?: string; error?: string }> = [];
    for (const repo of record.repos) {
      const expected = perRepoPrDescriptionName(repo);
      const match = payloadPaths.find((p) => p.endsWith(expected)) ?? (record.repos.length === 1 ? payloadPaths[0] : undefined);
      if (!match) {
        results.push({ repoPath: repo.path, error: "no matching pr-description.md payload for this repo" });
        continue;
      }
      const body = readArtifact(join(paths.repoRoot, match));
      if (!body) {
        results.push({ repoPath: repo.path, error: `payload file not found: ${match}` });
        continue;
      }
      try {
        const url = await createPr({ repoPath: workDir(repo), baseBranch: repo.baseBranch, body, titleHint: record.label });
        log.info("workflow.pr_created", { runId: record.runId, repo: repo.path, url });
        results.push({ repoPath: repo.path, url });
      } catch (err) {
        const msg = errMsg(err);
        log.error("workflow.pr_create_failed", { runId: record.runId, repo: repo.path, err: msg });
        results.push({ repoPath: repo.path, error: msg });
      }
    }

    if (results.some((r) => r.error)) {
      fail(record, results.map((r) => (r.error ? `${r.repoPath}: FAILED (${r.error})` : `${r.repoPath}: ${r.url}`)).join("\n"));
      return;
    }
    log.info("workflow.pr_run_complete", { runId: record.runId, summary: results.map((r) => `${r.repoPath}: ${r.url}`).join("\n") });
    goTo(record, "done", "PRs created");
    void refreshOverlaps(record); // a finished run no longer overlaps anyone
  },

};

function reopenGate(record: RunRecord, role: RoleId, action: ApprovalAction, summary: string, payloadPaths: string[]): void {
  const pending = requestApproval(record, role, { action, summary, payloadPaths });
  saveRun(record);
  emit({ type: "approval.requested", runId: record.runId, role, action, summary: pending.summary, payloadPaths });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Running a role
// ---------------------------------------------------------------------------

async function runRoleAsync(
  record: RunRecord,
  role: RoleId,
  ctx: RoleInputCtx = {},
  opts: { ignoreBudget?: boolean } = {},
): Promise<void> {
  const runId = record.runId;
  const spec = roleRegistry[role];
  if (!spec) {
    fail(record, `unknown role ${role}`);
    return;
  }

  // Cost budget: pause before starting another role once the run has spent it.
  let maxBudgetUsd: number | undefined;
  if (config.maxRunCostUsd > 0 && !opts.ignoreBudget) {
    const remaining = config.maxRunCostUsd - totalCostUsd(record);
    if (remaining <= 0) {
      pause(record, `cost budget of $${config.maxRunCostUsd.toFixed(2)} reached. Use "Jump" to continue anyway.`);
      return;
    }
    maxBudgetUsd = remaining;
  }

  stopInFlight(runId);
  const ctrl = new AbortController();
  inFlight.set(runId, ctrl);

  let jira: { tools: string[]; mcpServers: Record<string, unknown> };
  try {
    jira = jiraToolsForRun(record, spec);
  } catch (err) {
    fail(record, `${spec.title}: ${errMsg(err)}`);
    return;
  }

  const model = record.models?.[role] || config.models[role];
  const attempt = startAttempt(record, role);
  attempt.model = model;
  attempt.status = "queued";
  const attemptNumber = record.roles[role]?.length ?? 1;
  saveRun(record);

  let release: (() => void) | null = null;
  try {
    // 1. Isolated worktree(s) for this run — before taking a slot, since
    //    installing dependencies doesn't use the model.
    if (spec.needsWorkspace) {
      await prepareWorkspaces(record, (m) => systemMessage(record, role, m));
      saveRun(record);
    }

    // 2. Global concurrency limit across runs.
    release = await roleSlots.acquire(ctrl.signal, (position) => {
      emit({ type: "role.queued", runId, role, position });
      systemMessage(record, role, `waiting for a free slot (${position} in queue; MAX_CONCURRENT_ROLES=${config.maxConcurrentRoles})`);
    });
    if (ctrl.signal.aborted) throw new Error("aborted");
    attempt.status = "running";
    saveRun(record);
    emit({ type: "role.started", runId, role, attempt: attemptNumber });

    const outcome = await runRoleAgent({
      runId,
      role,
      spec,
      systemPrompt: loadPrompt(spec.promptFile),
      userPrompt: spec.buildInput(record, ctx),
      cwd: spec.cwdFor(record),
      model,
      repoPaths: record.repos.map(workDir),
      writeRoots: writeRootsFor(record, spec.writeScope),
      bashAllowList: [...spec.bashAllowList, ...(spec.extraBashAllowList?.(record) ?? [])],
      extraTools: jira.tools,
      mcpServers: jira.mcpServers,
      env: runEnv(record),
      maxBudgetUsd,
      signal: ctrl.signal,
    });

    // Free the slot before routing, so queued roles of other runs go first.
    release();
    attempt.sessionId = outcome.sessionId;
    attempt.endedAt = new Date().toISOString();
    if (outcome.metrics) {
      attempt.costUsd = outcome.metrics.costUsd;
      attempt.numTurns = outcome.metrics.numTurns;
      attempt.usage = outcome.metrics.usage;
    }

    if (ctrl.signal.aborted) {
      markAborted(record, role, attempt);
      return;
    }

    if (!outcome.output) {
      attempt.status = "failed";
      attempt.errorMessage = outcome.parseError ?? "role produced no terminal JSON block";
      saveRun(record);
      emit({ type: "role.ended", runId, role, status: "failed", artifacts: [] });
      fail(record, `${spec.title}: ${attempt.errorMessage}`);
      return;
    }

    attempt.output = outcome.output;
    attempt.status = outcome.output.status;
    saveRun(record);
    emit({ type: "role.ended", runId, role, status: outcome.output.status, artifacts: outcome.output.artifacts });

    if (spec.needsWorkspace) void refreshOverlaps(record);
    await handleRoleOutput(record, role, outcome.output);
  } catch (err) {
    attempt.endedAt = new Date().toISOString();
    if (ctrl.signal.aborted) {
      markAborted(record, role, attempt);
      return;
    }
    const msg = errMsg(err);
    attempt.status = "failed";
    attempt.errorMessage = msg;
    saveRun(record);
    emit({ type: "role.ended", runId, role, status: "failed", artifacts: [] });
    fail(record, `${spec.title}: ${msg}`);
  } finally {
    release?.();
    if (inFlight.get(runId) === ctrl) inFlight.delete(runId);
  }
}

/** Shared across all runs; the limit is re-read on every acquire. */
export const roleSlots = new Semaphore(() => config.maxConcurrentRoles);

function systemMessage(record: RunRecord, role: RoleId, text: string): void {
  emit({ type: "role.message", runId: record.runId, role, subtype: "system", text: `[orchestrator] ${text}` });
}

/**
 * An aborted role only records its own outcome. Whoever aborted it (abort,
 * jump) owns the run state, so we must not transition here.
 */
function markAborted(record: RunRecord, role: RoleId, attempt: RoleAttempt): void {
  attempt.status = "aborted";
  attempt.errorMessage = "aborted";
  attempt.endedAt ??= new Date().toISOString();
  saveRun(record);
  emit({ type: "role.ended", runId: record.runId, role, status: "aborted", artifacts: [] });
}

/**
 * JIRA MCP tools and server for a role. Only JIRA-sourced runs get them, so a
 * manual-source run never has JIRA access regardless of the prompt.
 */
export function jiraToolsForRun(record: RunRecord, spec: RoleSpec): { tools: string[]; mcpServers: Record<string, unknown> } {
  if (record.source.kind !== "jira" || !spec.jiraAccess) return { tools: [], mcpServers: {} };
  const cfg = loadJiraMcpConfig();
  if (!cfg) {
    if (spec.id === "analyst") throw new Error("this run is sourced from JIRA but no JIRA MCP server is configured");
    return { tools: [], mcpServers: {} };
  }
  return { tools: jiraToolsFor(cfg, spec.jiraAccess), mcpServers: mcpServersOption(cfg) };
}

export function writeRootsFor(record: RunRecord, scope: "run" | "repos-and-run"): string[] {
  const run = runDir(record.runId);
  return scope === "run" ? [run] : [run, ...record.repos.map(workDir)];
}

async function handleRoleOutput(record: RunRecord, role: RoleId, output: RoleOutput): Promise<void> {
  if (output.status === "blocked") {
    if (output.handoff && output.handoff.nextRole !== role) {
      const target = output.handoff.nextRole;
      // Handing work back to the Developer or Unit Tester is a fix loop.
      if ((target === "developer" || target === "unitTester") && !admitFixLoop(record, `${role} handed back to ${target}`)) return;
      startRole(record, target, `handoff from ${role}${output.handoff.notes ? `: ${output.handoff.notes}` : ""}`, {
        handoff: { from: role, notes: output.handoff.notes },
      });
      return;
    }
    // A blocked role usually needs a human (red suite before starting, missing
    // test runner, unreachable ticket). Pause so the user can fix it and jump.
    pause(record, `${roleRegistry[role].title} is blocked: ${output.handoff?.notes ?? output.approvalRequest?.summary ?? "see the role stream"}`);
    return;
  }

  if (output.status === "awaiting_approval") {
    if (!output.approvalRequest) {
      fail(record, `${roleRegistry[role].title} reported awaiting_approval without an approvalRequest`);
      return;
    }
    const gate = gateStateFor(role, output.approvalRequest.action);
    if (!gate) {
      fail(record, `${roleRegistry[role].title} requested approval action "${output.approvalRequest.action}", which it is not allowed to request`);
      return;
    }
    if (gate === "awaiting_review_decision" && config.reviewAutoRoute && autoRouteReview(record)) return;

    const pending = requestApproval(record, role, output.approvalRequest);
    goTo(record, gate, `${role} awaiting ${output.approvalRequest.action}`);
    emit({
      type: "approval.requested",
      runId: record.runId,
      role,
      action: pending.action,
      summary: pending.summary,
      payloadPaths: pending.payloadPaths,
    });
    return;
  }

  // status === "done": the state machine, not the role, decides what's next.
  const next = nextAfterDone(record.state);
  if (next === "complete") {
    goTo(record, "done", "workflow complete");
  } else if (next === "plan_gate") {
    const pending = requestApproval(record, "developer", {
      action: "proceed_to_next",
      summary: "Developer finished planning. Review the ADR and implementation plan.",
      payloadPaths: [],
    });
    goTo(record, "awaiting_plan_approval", "plan ready");
    emit({ type: "approval.requested", runId: record.runId, role: "developer", action: pending.action, summary: pending.summary, payloadPaths: [] });
  } else if (next) {
    startRole(record, next, `${role} done`);
  } else {
    fail(record, `${roleRegistry[role].title} reported done in unexpected state ${record.state}`);
  }
}

/** Returns true if the review gate was decided automatically. */
function autoRouteReview(record: RunRecord): boolean {
  const findings = readReviewFindings(record);
  if (!findings) {
    log.warn("workflow.review_findings_missing", { runId: record.runId });
    return false; // fall back to the manual gate
  }
  const blocking = findings.blocker + findings.high;
  const summary = `review findings: ${findings.blocker} blocker / ${findings.high} high / ${findings.med} med / ${findings.low} low / ${findings.nit} nit`;
  emit({ type: "role.message", runId: record.runId, role: "reviewer", subtype: "system", text: `[orchestrator] auto-routing ${summary}` });
  if (blocking > 0) {
    if (admitFixLoop(record, `${blocking} blocking review finding(s)`)) {
      startRole(record, "developer_implementing", `auto-route: ${summary}`, { signal: "review_fixes_required" });
    }
  } else {
    startRole(record, "e2e_tester_running", `auto-route: ${summary}`);
  }
  return true;
}

function loadPrompt(file: string): string {
  return readFileSync(join(paths.rolesDir, file), "utf8");
}

async function enterBranchNamesGate(record: RunRecord): Promise<void> {
  let proposals: BranchProposal[];
  try {
    proposals = await proposeBranches(record);
  } catch (err) {
    fail(record, `could not propose branches: ${errMsg(err)}`);
    return;
  }

  const payloadRelative = writeProposedBranches(record.runId, proposals);
  const pending = requestApproval(record, "developer", {
    action: "approve_branch_names",
    summary: `Approve or edit the branch name for ${proposals.length} repo(s). The orchestrator will create/switch to each before the Unit Tester writes the first failing tests.`,
    payloadPaths: [payloadRelative],
  });
  goTo(record, "awaiting_branch_names", "plan approved; proposing branches");
  emit({
    type: "approval.requested",
    runId: record.runId,
    role: pending.role,
    action: pending.action,
    summary: pending.summary,
    payloadPaths: pending.payloadPaths,
  });
}

function parseEditedBranches(record: RunRecord, raw: string | undefined): BranchProposal[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { perRepo?: Array<Partial<BranchProposal>> };
    const entries = parsed.perRepo ?? [];
    if (entries.length === 0) return null;
    return entries
      .map((e) => {
        const repoPath = String(e.repoPath ?? "");
        const matching = record.repos.find((r) => r.path === repoPath);
        return {
          repoPath,
          baseBranch: String(e.baseBranch ?? matching?.baseBranch ?? "master"),
          currentBranch: e.currentBranch ?? null,
          suggestedBranch: String(e.suggestedBranch ?? "").trim(),
        };
      })
      // Only repos that belong to this run may be touched.
      .filter((e) => e.repoPath && e.suggestedBranch && record.repos.some((r) => r.path === e.repoPath));
  } catch {
    return null;
  }
}
