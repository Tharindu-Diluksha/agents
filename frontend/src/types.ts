export const ROLES = [
  "analyst",
  "developer",
  "unitTester",
  "integrationTester",
  "reviewer",
  "e2eTester",
  "prCreator",
] as const;
export type RoleId = (typeof ROLES)[number];

export const ROLE_LABELS: Record<RoleId, string> = {
  analyst: "Analyst",
  developer: "Developer",
  unitTester: "Unit Tester",
  integrationTester: "Integration Tester",
  reviewer: "Reviewer",
  e2eTester: "E2E Tester",
  prCreator: "PR Creator",
};

export type RunState =
  | "created"
  | "analyst_running"
  | "awaiting_feature_doc_approval"
  | "awaiting_jira_comment_decision"
  | "developer_planning"
  | "awaiting_plan_approval"
  | "awaiting_branch_names"
  | "unit_tests_red_running"
  | "developer_implementing"
  | "unit_tests_green_running"
  | "integration_tester_running"
  | "reviewer_running"
  | "awaiting_review_decision"
  | "e2e_tester_running"
  | "awaiting_test_suite_approval"
  | "pr_creator_running"
  | "awaiting_pr_approval"
  | "paused"
  | "done"
  | "failed";

export type ApprovalAction =
  | "post_jira_comment"
  | "create_test_suite"
  | "create_pr"
  | "approve_branch_names"
  | "proceed_to_next";

export interface PendingApproval {
  runId: string;
  role: RoleId;
  action: ApprovalAction;
  summary: string;
  payloadPaths: string[];
  requestedAt: string;
}

export interface ProposedBranches {
  perRepo: Array<{ repoPath: string; baseBranch: string; currentBranch: string | null; suggestedBranch: string; note?: string }>;
}

export const STACK_IDS = ["typescript", "node", "vue", "react", "dotnet", "python", "go"] as const;
export type StackId = (typeof STACK_IDS)[number];

export interface RepoTarget {
  path: string;
  /** Tech stacks, primary first. Absent on runs created before stack profiles (treated as TypeScript). */
  stacks?: StackId[];
  baseBranch: string;
  aiGuidelinePath: string | null;
  /** This run's git worktree for the repo, once created. */
  workPath?: string | null;
  branch?: string | null;
  baseRef?: string | null;
}

export type SourceType = "feature" | "change" | "fix";

export interface JiraSource {
  kind: "jira";
  ticket: string;
  ticketUrl: string;
}

export interface ManualSource {
  kind: "manual";
  type: SourceType;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export type RunSource = JiraSource | ManualSource;

export interface RunSummary {
  runId: string;
  label: string;
  source: RunSource;
  repos: RepoTarget[];
  state: RunState;
  createdAt: string;
  updatedAt: string;
  pendingApproval: PendingApproval | null;
  totalCostUsd: number;
  totalUsage: AttemptUsage;
  overlaps?: Overlap[];
  pauseReason?: string;
  failureReason?: string;
}

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type AttemptStatus = "queued" | "running" | "done" | "awaiting_approval" | "blocked" | "failed" | "aborted";

export interface RoleAttempt {
  startedAt: string;
  endedAt?: string;
  status: AttemptStatus;
  state?: RunState;
  sessionId?: string;
  errorMessage?: string;
  model?: string;
  costUsd?: number;
  numTurns?: number;
  usage?: AttemptUsage;
}

export interface RunDetail extends RunSummary {
  workspace?: "worktree" | "in-place";
  ports?: { base: number; count: number } | null;
  roles: Partial<Record<RoleId, RoleAttempt[]>>;
  models?: Partial<Record<RoleId, string>>;
  effectiveModels: Record<RoleId, string>;
  fixIterations?: number;
  pauseReason?: string;
  stateHistory: Array<{ at: string; from: RunState; to: RunState; reason?: string }>;
  artifacts: Array<{ owner: RoleId | "orchestrator"; name: string; relative: string }>;
  failureReason?: string;
}

/** Server events carry a timestamp; persisted ones also a per-run sequence number. */
export type RunEvent = RawRunEvent & { at?: string; seq?: number };

export interface Overlap {
  otherRunId: string;
  otherLabel: string;
  repoPath: string;
  files: string[];
}

type RawRunEvent =
  | { type: "ws.hello"; runId?: string; scope?: string }
  | { type: "run.overlaps"; runId: string; overlaps: Overlap[] }
  | { type: "run.created"; runId: string; label: string; repoPaths: string[] }
  | { type: "run.transitioned"; runId: string; from: RunState; to: RunState }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "role.started"; runId: string; role: RoleId; attempt: number }
  | { type: "role.queued"; runId: string; role: RoleId; position: number }
  | { type: "role.message"; runId: string; role: RoleId; text: string; subtype: "assistant" | "user" | "system" }
  | { type: "role.tool_call"; runId: string; role: RoleId; name: string; input: unknown; toolUseId: string }
  | { type: "role.tool_result"; runId: string; role: RoleId; toolUseId: string; isError: boolean; summary: string }
  | { type: "role.ended"; runId: string; role: RoleId; status: AttemptStatus; artifacts: string[] }
  | { type: "role.usage"; runId: string; role: RoleId; usage: AttemptUsage; costUsd: number; final: boolean }
  | { type: "approval.requested"; runId: string; role: RoleId; action: string; summary: string; payloadPaths: string[] }
  | { type: "approval.resolved"; runId: string; role: RoleId; action: string; decision: "approve" | "reject" | "edit" | "skip" };

export interface JiraMcpSummary {
  configured: boolean;
  error?: string;
  serverName?: string;
  transport?: "stdio" | "http" | "sse";
  target?: string;
  source?: string;
  tools?: { getIssue: string; searchIssues: string | null; addComment: string; readOnlyExtras: string[] };
}

export interface JiraMcpTestResult {
  ok: boolean;
  serverName?: string;
  status?: string;
  toolsFound: string[];
  toolsMissing: string[];
  serverTools: string[];
  error?: string;
}

export interface ServerConfig {
  roles: RoleId[];
  models: Record<RoleId, string>;
  maxFixIterations: number;
  maxRunCostUsd: number;
  reviewAutoRoute: boolean;
  jira: JiraMcpSummary;
  stacks: Array<{ id: StackId; label: string; summary: string }>;
  maxConcurrentRoles: number;
  worktreesDir: string;
  ports: { rangeStart: number; rangeEnd: number; blockSize: number };
  syncBaseBeforePr: boolean;
}

export interface Slots {
  limit: number;
  running: number;
  queued: number;
}

export function stateChipClass(state: RunState): string {
  if (state === "done") return "done";
  if (state === "failed") return "failed";
  if (state === "paused") return "paused";
  if (state.startsWith("awaiting_")) return "awaiting";
  if (state === "created") return "idle";
  return "running";
}

export function formatUsd(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}

export function emptyUsage(): AttemptUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

export function addUsage(a: AttemptUsage, b: AttemptUsage | undefined): AttemptUsage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
  };
}

/** All tokens processed: uncached input + cache reads + cache writes + output. */
export function totalTokens(u: AttemptUsage | undefined): number {
  if (!u) return 0;
  return u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens;
}

export function formatTokens(n: number | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(v);
}
