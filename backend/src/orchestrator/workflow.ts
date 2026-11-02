import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { runRoleAgent } from "../sdk/runRole.js";
import { roles as roleRegistry } from "../roles/index.js";
import { postJiraComment } from "../external/jiraMcp.js";
import { createPr } from "../external/gh.js";
import { checkoutOrCreateBranch } from "../external/git.js";
import { clearApproval, requestApproval } from "./approvals.js";
import { perRepoPrDescriptionName, readArtifact } from "./artifacts.js";
import { proposeBranches, readProposedBranches, writeProposedBranches, type BranchProposal } from "./branches.js";
import { loadRun, saveRun, startAttempt, transition } from "./runStore.js";
import type { RoleId, RoleOutput, RunRecord, RunState } from "./types.js";

const inFlight = new Map<string, AbortController>();

export async function startRun(runId: string): Promise<void> {
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  if (record.state !== "created") {
    throw new Error(`run ${runId} already started (state=${record.state})`);
  }
  transition(record, "analyst_running", "manual launch");
  saveRun(record);
  emit({ type: "run.transitioned", runId, from: "created", to: "analyst_running" });
  void runRoleAsync(record, "analyst");
}

export async function resumeAfterApproval(
  runId: string,
  decision: "approve" | "reject" | "edit" | "skip",
  editedPayload?: string,
  feedback?: string,
): Promise<void> {
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  const pending = record.pendingApproval;
  if (!pending) throw new Error(`run ${runId} has no pending approval`);

  emit({
    type: "approval.resolved",
    runId,
    role: pending.role,
    action: pending.action,
    decision,
  });

  clearApproval(record);
  saveRun(record);

  const prev = record.state;
  const resolver = approvalResolvers[pending.action];
  if (!resolver) {
    log.warn("workflow.unknown_approval_action", { runId, action: pending.action });
    return;
  }
  await resolver(record, decision, { editedPayload, feedback, prevState: prev });
}

export async function jumpToRole(runId: string, role: RoleId): Promise<void> {
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  const fromState = record.state;
  const targetState = roleRunningState(role);
  transition(record, targetState, `jump to ${role}`);
  clearApproval(record);
  saveRun(record);
  emit({ type: "run.transitioned", runId, from: fromState, to: targetState });
  void runRoleAsync(record, role);
}

export async function skipCurrent(runId: string): Promise<void> {
  const record = loadRun(runId);
  if (!record) throw new Error(`unknown run ${runId}`);
  const next = nextStateAfterSkip(record.state);
  if (!next) throw new Error(`cannot skip from ${record.state}`);
  const from = record.state;
  transition(record, next.state, "skip");
  clearApproval(record);
  saveRun(record);
  emit({ type: "run.transitioned", runId, from, to: next.state });
  if (next.spawnRole) void runRoleAsync(record, next.spawnRole);
}

export function abortRun(runId: string): void {
  const ctrl = inFlight.get(runId);
  if (ctrl) {
    ctrl.abort();
    inFlight.delete(runId);
  }
}

function roleRunningState(role: RoleId): RunState {
  switch (role) {
    case "analyst":
      return "analyst_running";
    case "developer":
      return "developer_planning";
    case "reviewer":
      return "reviewer_running";
    case "tester":
      return "tester_running";
    case "prCreator":
      return "pr_creator_running";
  }
}

function nextStateAfterSkip(state: RunState): { state: RunState; spawnRole?: RoleId } | null {
  switch (state) {
    case "awaiting_feature_doc_approval":
    case "awaiting_jira_comment_decision":
      return { state: "developer_planning", spawnRole: "developer" };
    case "awaiting_plan_approval":
      return { state: "developer_implementing", spawnRole: "developer" };
    case "awaiting_branch_names":
      // Skipping branch setup is dangerous — Developer may commit to the base
      // branch. We fail fast rather than silently advance.
      return null;
    case "awaiting_review_decision":
      return { state: "tester_running", spawnRole: "tester" };
    case "awaiting_test_suite_approval":
      return { state: "pr_creator_running", spawnRole: "prCreator" };
    case "awaiting_pr_approval":
      return { state: "done" };
    default:
      return null;
  }
}

type ApprovalResolverCtx = {
  editedPayload?: string;
  feedback?: string;
  prevState: RunState;
};

const approvalResolvers: Record<
  string,
  (record: RunRecord, decision: "approve" | "reject" | "edit" | "skip", ctx: ApprovalResolverCtx) => Promise<void>
> = {
  async proceed_to_next(record, decision, ctx) {
    const runId = record.runId;
    const from = record.state;
    if (ctx.prevState === "awaiting_feature_doc_approval") {
      if (decision === "approve") {
        transition(record, "developer_planning", "feature doc approved");
        saveRun(record);
        emit({ type: "run.transitioned", runId, from, to: "developer_planning" });
        void runRoleAsync(record, "developer");
      } else {
        transition(record, "analyst_running", "feature doc rejected");
        saveRun(record);
        emit({ type: "run.transitioned", runId, from, to: "analyst_running" });
        void runRoleAsync(record, "analyst", ctx.feedback);
      }
    } else if (ctx.prevState === "awaiting_plan_approval") {
      if (decision === "approve") {
        await enterBranchNamesGate(record, from);
      } else {
        transition(record, "developer_planning", "plan rejected");
        saveRun(record);
        emit({ type: "run.transitioned", runId, from, to: "developer_planning" });
        void runRoleAsync(record, "developer", ctx.feedback);
      }
    } else if (ctx.prevState === "awaiting_review_decision") {
      if (decision === "approve") {
        transition(record, "tester_running", "review passed");
        saveRun(record);
        emit({ type: "run.transitioned", runId, from, to: "tester_running" });
        void runRoleAsync(record, "tester");
      } else {
        transition(record, "developer_implementing", "fixes required");
        saveRun(record);
        emit({ type: "run.transitioned", runId, from, to: "developer_implementing" });
        void runRoleAsync(record, "developer", "review_report_attached");
      }
    } else {
      log.warn("workflow.proceed_unknown_prev", { runId, prevState: ctx.prevState });
    }
  },

  async approve_branch_names(record, decision, ctx) {
    const runId = record.runId;
    const from = record.state;
    if (decision !== "approve" && decision !== "edit") {
      // reject / skip both abort the whole run — the Developer can't commit without branches.
      const reason =
        decision === "skip"
          ? "branch creation skipped; run cannot continue without a feature branch per repo"
          : "branch names rejected; run cancelled";
      transition(record, "failed", reason);
      record.failureReason = reason;
      saveRun(record);
      emit({ type: "run.failed", runId, error: reason });
      return;
    }

    const proposals = parseEditedBranches(record, ctx.editedPayload) ?? readProposedBranches(runId);
    if (!proposals || proposals.length === 0) {
      const reason = "no branch proposals found for this run";
      transition(record, "failed", reason);
      record.failureReason = reason;
      saveRun(record);
      emit({ type: "run.failed", runId, error: reason });
      return;
    }

    const results: Array<{ repoPath: string; branch: string; outcome?: string; error?: string }> = [];
    for (const p of proposals) {
      try {
        const outcome = await checkoutOrCreateBranch(p.repoPath, p.suggestedBranch, p.baseBranch);
        log.info("workflow.branch_ready", { runId, repo: p.repoPath, branch: p.suggestedBranch, outcome });
        results.push({ repoPath: p.repoPath, branch: p.suggestedBranch, outcome });
      } catch (err) {
        const msg = errMsg(err);
        log.error("workflow.branch_failed", { runId, repo: p.repoPath, branch: p.suggestedBranch, err: msg });
        results.push({ repoPath: p.repoPath, branch: p.suggestedBranch, error: msg });
      }
    }

    const anyError = results.some((r) => r.error);
    if (anyError) {
      const summary = results
        .map((r) => (r.error ? `${r.repoPath} (${r.branch}): FAILED — ${r.error}` : `${r.repoPath}: ${r.branch} ${r.outcome}`))
        .join("\n");
      transition(record, "failed", "branch setup failed");
      record.failureReason = summary;
      saveRun(record);
      emit({ type: "run.failed", runId, error: summary });
      return;
    }

    emit({
      type: "role.message",
      runId,
      role: "developer",
      subtype: "system",
      text: `[orchestrator] prepared ${results.length} branch(es):\n${results
        .map((r) => `- ${r.repoPath}: ${r.branch} (${r.outcome})`)
        .join("\n")}`,
    });

    transition(record, "developer_implementing", "branches ready");
    saveRun(record);
    emit({ type: "run.transitioned", runId, from, to: "developer_implementing" });
    void runRoleAsync(record, "developer", "plan_approved");
  },

  async post_jira_comment(record, decision, ctx) {
    const runId = record.runId;
    const from = record.state;
    if (decision === "approve" && record.source.kind === "jira") {
      const path = resolvePath(record, "analyst", "proposed-jira-comment.md");
      const body = ctx.editedPayload ?? readArtifact(path) ?? "";
      try {
        await postJiraComment(record.source.ticket, body);
        log.info("workflow.jira_comment_posted", { runId, ticket: record.source.ticket });
      } catch (err) {
        log.error("workflow.jira_comment_failed", { runId, err: errMsg(err) });
      }
    } else if (decision === "approve" && record.source.kind !== "jira") {
      log.warn("workflow.jira_comment_skipped_manual_source", { runId });
    }
    transition(record, "developer_planning", "post-jira-comment resolved");
    saveRun(record);
    emit({ type: "run.transitioned", runId, from, to: "developer_planning" });
    void runRoleAsync(record, "developer");
  },

  // (create_pr defined below so it can use helpers)

  async create_test_suite(record, decision, ctx) {
    const runId = record.runId;
    const from = record.state;
    if (decision === "approve") {
      transition(record, "tester_running", "test suite creation approved");
      saveRun(record);
      emit({ type: "run.transitioned", runId, from, to: "tester_running" });
      void runRoleAsync(record, "tester", "create_suite_approved");
    } else {
      transition(record, "failed", "tester cannot proceed without a suite");
      record.failureReason = "User declined Playwright suite creation; tester cannot proceed.";
      saveRun(record);
      emit({ type: "run.failed", runId, error: record.failureReason });
    }
  },

  async create_pr(record, decision, ctx) {
    const runId = record.runId;
    const from = record.state;
    if (decision !== "approve") {
      transition(record, "pr_creator_running", "PR descriptions rejected");
      saveRun(record);
      emit({ type: "run.transitioned", runId, from, to: "pr_creator_running" });
      void runRoleAsync(record, "prCreator", ctx.feedback);
      return;
    }

    const payloadPaths = record.pendingApproval?.payloadPaths ?? [];
    // Attempt one PR per repo. Match payload paths to repos by filename slug
    // the PR Creator role used (`<repoSlug>-pr-description.md`). If a repo has
    // no matching file but there's a single legacy pr-description.md, use that
    // for the single-repo case.
    const results: Array<{ repoPath: string; url?: string; error?: string }> = [];
    for (const repo of record.repos) {
      const expected = perRepoPrDescriptionName(repo);
      const match =
        payloadPaths.find((p) => p.endsWith(expected)) ??
        (record.repos.length === 1 ? payloadPaths[0] : undefined);
      if (!match) {
        results.push({ repoPath: repo.path, error: "no matching pr-description.md payload for this repo" });
        continue;
      }
      const abs = resolveFromRepoRoot(match);
      const body = readArtifact(abs);
      if (!body) {
        results.push({ repoPath: repo.path, error: `payload file not found: ${match}` });
        continue;
      }
      try {
        const url = await createPr({
          repoPath: repo.path,
          baseBranch: repo.baseBranch,
          body,
          titleHint: record.label,
        });
        log.info("workflow.pr_created", { runId, repo: repo.path, url });
        results.push({ repoPath: repo.path, url });
      } catch (err) {
        const msg = errMsg(err);
        log.error("workflow.pr_create_failed", { runId, repo: repo.path, err: msg });
        results.push({ repoPath: repo.path, error: msg });
      }
    }

    const anyError = results.some((r) => r.error);
    if (anyError) {
      const summary = results
        .map((r) => (r.error ? `${r.repoPath}: FAILED (${r.error})` : `${r.repoPath}: ${r.url}`))
        .join("\n");
      transition(record, "failed", "one or more PRs failed");
      record.failureReason = summary;
      saveRun(record);
      emit({ type: "run.failed", runId, error: summary });
      return;
    }

    const summary = results.map((r) => `${r.repoPath}: ${r.url}`).join("\n");
    log.info("workflow.pr_run_complete", { runId, summary });
    transition(record, "done", "PRs created");
    saveRun(record);
    emit({ type: "run.transitioned", runId, from, to: "done" });
  },
};

function resolveFromRepoRoot(relative: string): string {
  // Payloads emitted by roles are expressed relative to the project root
  // (e.g. `runs/<id>/<role>/<file>`). Resolve against it.
  return join(paths.repoRoot, relative);
}

function resolvePath(record: RunRecord, role: string, file: string): string {
  return join(paths.runsDir, record.runId, role, file);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Public re-entry used by the startup recovery pass. See
 * `./recovery.ts` + `./workflowResume.ts`.
 */
export async function runRoleViaWorkflow(record: RunRecord, role: RoleId, feedback?: string): Promise<void> {
  await runRoleAsync(record, role, feedback);
}

async function runRoleAsync(record: RunRecord, role: RoleId, feedback?: string): Promise<void> {
  const runId = record.runId;
  const spec = roleRegistry[role];
  if (!spec) {
    log.error("workflow.unknown_role", { runId, role });
    return;
  }

  const ctrl = new AbortController();
  inFlight.set(runId, ctrl);

  const attempt = startAttempt(record, role);
  const attemptNumber = (record.roles[role]?.length ?? 1);
  saveRun(record);
  emit({ type: "role.started", runId, role, attempt: attemptNumber });

  try {
    const systemPrompt = loadPrompt(spec.promptFile);
    const userPrompt = spec.buildInput(record, { feedback });

    const outcome = await runRoleAgent({
      runId,
      role,
      spec,
      systemPrompt,
      userPrompt,
      cwd: spec.cwdFor(record),
      repoPaths: record.repos.map((r) => r.path),
      signal: ctrl.signal,
    });

    attempt.sessionId = outcome.sessionId;
    attempt.endedAt = new Date().toISOString();

    if (!outcome.output) {
      attempt.status = "failed";
      attempt.errorMessage = outcome.parseError ?? "role produced no terminal JSON block";
      saveRun(record);
      emit({ type: "role.ended", runId, role, status: "failed", artifacts: [] });
      transition(record, "failed", attempt.errorMessage);
      record.failureReason = attempt.errorMessage;
      saveRun(record);
      emit({ type: "run.failed", runId, error: attempt.errorMessage });
      return;
    }

    attempt.output = outcome.output;
    attempt.status = outcome.output.status;
    saveRun(record);
    emit({
      type: "role.ended",
      runId,
      role,
      status: outcome.output.status,
      artifacts: outcome.output.artifacts,
    });

    await handleRoleOutput(record, role, outcome.output);
  } catch (err) {
    const msg = errMsg(err);
    attempt.status = "failed";
    attempt.errorMessage = msg;
    attempt.endedAt = new Date().toISOString();
    saveRun(record);
    emit({ type: "role.ended", runId, role, status: "failed", artifacts: [] });
    transition(record, "failed", msg);
    record.failureReason = msg;
    saveRun(record);
    emit({ type: "run.failed", runId, error: msg });
  } finally {
    if (inFlight.get(runId) === ctrl) inFlight.delete(runId);
  }
}

async function handleRoleOutput(record: RunRecord, role: RoleId, output: RoleOutput): Promise<void> {
  const runId = record.runId;
  const from = record.state;

  if (output.status === "blocked") {
    if (output.handoff) {
      const target = roleRunningState(output.handoff.nextRole);
      transition(record, target, `handoff from ${role}: ${output.handoff.notes ?? ""}`);
      saveRun(record);
      emit({ type: "run.transitioned", runId, from, to: target });
      void runRoleAsync(record, output.handoff.nextRole, `handoff_from_${role}`);
      return;
    }
    const reason = output.approvalRequest?.summary ?? `${role} reported blocked`;
    transition(record, "failed", reason);
    record.failureReason = reason;
    saveRun(record);
    emit({ type: "run.failed", runId, error: reason });
    return;
  }

  if (output.status === "awaiting_approval" && output.approvalRequest) {
    const next = gateStateFor(role, output.approvalRequest.action);
    const pending = requestApproval(record, role, output.approvalRequest);
    transition(record, next, `${role} awaiting ${output.approvalRequest.action}`);
    saveRun(record);
    emit({ type: "run.transitioned", runId, from, to: next });
    emit({
      type: "approval.requested",
      runId,
      role,
      action: pending.action,
      summary: pending.summary,
      payloadPaths: pending.payloadPaths,
    });
    return;
  }

  if (output.status === "done") {
    if (output.handoff) {
      const target = roleRunningState(output.handoff.nextRole);
      transition(record, target, `handoff from ${role}`);
      saveRun(record);
      emit({ type: "run.transitioned", runId, from, to: target });
      void runRoleAsync(record, output.handoff.nextRole);
      return;
    }
    const nextRole = defaultNextRole(role);
    if (!nextRole) {
      transition(record, "done", "workflow complete");
      saveRun(record);
      emit({ type: "run.transitioned", runId, from, to: "done" });
      return;
    }
    const target = roleRunningState(nextRole);
    transition(record, target, `auto-advance after ${role}`);
    saveRun(record);
    emit({ type: "run.transitioned", runId, from, to: target });
    void runRoleAsync(record, nextRole);
  }
}

function defaultNextRole(role: RoleId): RoleId | null {
  switch (role) {
    case "analyst":
      return "developer";
    case "developer":
      return "reviewer";
    case "reviewer":
      return "tester";
    case "tester":
      return "prCreator";
    case "prCreator":
      return null;
  }
}

function gateStateFor(role: RoleId, action: string): RunState {
  if (role === "analyst" && action === "post_jira_comment") return "awaiting_jira_comment_decision";
  if (role === "analyst" && action === "proceed_to_next") return "awaiting_feature_doc_approval";
  if (role === "developer" && action === "proceed_to_next") return "awaiting_plan_approval";
  if (role === "reviewer" && action === "proceed_to_next") return "awaiting_review_decision";
  if (role === "tester" && action === "create_test_suite") return "awaiting_test_suite_approval";
  if (role === "prCreator" && action === "create_pr") return "awaiting_pr_approval";
  return "failed";
}

function loadPrompt(file: string): string {
  return readFileSync(join(paths.rolesDir, file), "utf8");
}

async function enterBranchNamesGate(record: RunRecord, fromState: RunState): Promise<void> {
  const runId = record.runId;
  let proposals: BranchProposal[];
  try {
    proposals = await proposeBranches(record);
  } catch (err) {
    const msg = `could not propose branches: ${errMsg(err)}`;
    log.error("workflow.propose_branches_failed", { runId, err: msg });
    transition(record, "failed", msg);
    record.failureReason = msg;
    saveRun(record);
    emit({ type: "run.failed", runId, error: msg });
    return;
  }

  const payloadRelative = writeProposedBranches(runId, proposals);
  const summary = `Approve or edit the branch name for ${proposals.length} repo(s). The orchestrator will create/switch to each before the Developer starts implementing.`;
  const pending = requestApproval(record, "developer", {
    action: "approve_branch_names",
    summary,
    payloadPaths: [payloadRelative],
  });
  transition(record, "awaiting_branch_names", "plan approved; proposing branches");
  saveRun(record);
  emit({ type: "run.transitioned", runId, from: fromState, to: "awaiting_branch_names" });
  emit({
    type: "approval.requested",
    runId,
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
    return entries.map((e) => {
      const repoPath = String(e.repoPath ?? "");
      const matching = record.repos.find((r) => r.path === repoPath);
      return {
        repoPath,
        baseBranch: String(e.baseBranch ?? matching?.baseBranch ?? "master"),
        currentBranch: e.currentBranch ?? null,
        suggestedBranch: String(e.suggestedBranch ?? "").trim(),
      };
    }).filter((e) => e.repoPath && e.suggestedBranch);
  } catch {
    return null;
  }
}
