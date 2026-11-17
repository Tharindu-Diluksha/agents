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

/** Reasoning effort levels (Agent SDK `effort`). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Roles every run includes (mirrors the backend; the server's /api/config value wins). */
export const REQUIRED_ROLES: readonly RoleId[] = ["analyst", "developer", "reviewer"];

/** What each role does, for the launch dialog. */
export const ROLE_HINTS: Record<RoleId, string> = {
  analyst: "Turns the ticket or description into a feature doc",
  developer: "Plans, then implements the change",
  unitTester: "Writes failing unit tests first, then verifies them (without it the Developer writes the tests)",
  integrationTester: "Tests the change across module / service boundaries",
  reviewer: "Reviews the diff and can send it back for fixes",
  e2eTester: "Runs end-to-end tests against the running app",
  prCreator: "Writes the PR description and opens the PR after approval (without it the run ends with a local branch)",
};

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

/** Plain-language run states, for hand-off lines in the stream. */
export const STATE_LABELS: Record<RunState, string> = {
  created: "Created",
  analyst_running: "Analyst analysing",
  awaiting_feature_doc_approval: "Waiting for your feature-doc approval",
  awaiting_jira_comment_decision: "Waiting for your JIRA comment decision",
  developer_planning: "Developer planning",
  awaiting_plan_approval: "Waiting for your plan approval",
  awaiting_branch_names: "Waiting for your branch names",
  unit_tests_red_running: "Unit Tester writing failing tests",
  developer_implementing: "Developer implementing",
  unit_tests_green_running: "Unit Tester verifying",
  integration_tester_running: "Integration Tester testing",
  reviewer_running: "Reviewer reviewing",
  awaiting_review_decision: "Waiting for your review decision",
  e2e_tester_running: "E2E Tester testing",
  awaiting_test_suite_approval: "Waiting for your E2E suite approval",
  pr_creator_running: "PR Creator writing the PR",
  awaiting_pr_approval: "Waiting for your PR approval",
  paused: "Run paused",
  done: "Run complete",
  failed: "Run failed",
};

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

export const STACK_IDS = ["typescript", "node", "vue", "react", "angular", "dotnet", "python", "go"] as const;
export type StackId = (typeof STACK_IDS)[number];

/** Where a stack lives in a repo: "." = the root, otherwise a top-level folder (monorepos). */
export interface StackProject {
  dir: string;
  stack: StackId;
}

export interface RepoTarget {
  path: string;
  /** Tech stacks, primary first. Absent on runs created before stack profiles (treated as TypeScript). */
  stacks?: StackId[];
  /** Folder of each stack. Absent = every stack at the root. */
  projects?: StackProject[];
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
  /** Pull requests opened for this run, one per repo. */
  pullRequests?: { repoPath: string; url: string }[];
  /** Open questions the orchestrator posted to the JIRA ticket. */
  jiraComments?: { postedAt: string; ticket: string; openQuestions: number }[];
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
  effort?: EffortLevel;
  costUsd?: number;
  numTurns?: number;
  usage?: AttemptUsage;
  /** Answers / feedback the user sent from an approval card to start this attempt. */
  feedback?: string;
}

export interface RunDetail extends RunSummary {
  workspace?: "worktree" | "in-place";
  ports?: { base: number; count: number } | null;
  roles: Partial<Record<RoleId, RoleAttempt[]>>;
  models?: Partial<Record<RoleId, string>>;
  effectiveModels: Record<RoleId, string>;
  efforts?: Partial<Record<RoleId, EffortLevel>>;
  /** null = the model's default effort. */
  effectiveEfforts?: Record<RoleId, EffortLevel | null>;
  /** Optional roles turned off at launch. */
  disabledRoles?: RoleId[];
  /** Notes and images the user added (launch dialog or run page). */
  attachments?: RunAttachment[];
  fixIterations?: number;
  pauseReason?: string;
  stateHistory: Array<{ at: string; from: RunState; to: RunState; reason?: string }>;
  artifacts: Array<{ owner: RoleId | "orchestrator"; name: string; relative: string }>;
  failureReason?: string;
}

export interface RunAttachment {
  id: string;
  kind: "note" | "image";
  addedAt: string;
  stage: RunState;
  /** Note body, or an image's caption. */
  text?: string;
  file?: string;
  originalName?: string;
  mediaType?: string;
}

/** Notes + images being composed in the UI, before upload. */
export interface PendingImage {
  file: File;
  /** Object URL for the preview thumbnail. */
  url: string;
  caption: string;
}
export interface ContextDraft {
  note: string;
  images: PendingImage[];
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
  | { type: "run.removed"; runId: string; archived: boolean }
  | { type: "run.attachments"; runId: string; added: number }
  | { type: "role.settings"; runId: string; role: RoleId; model: string | null; effort: EffortLevel | null }
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
  /** Roles that can't be turned off at launch. */
  requiredRoles: RoleId[];
  models: Record<RoleId, string>;
  /** Model ids offered in the launch dialog's dropdowns. */
  modelOptions: string[];
  /** Server default effort per role; null = the model's default. */
  efforts: Record<RoleId, EffortLevel | null>;
  effortLevels: EffortLevel[];
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

export interface RoleStats {
  role: RoleId;
  attempts: number;
  costUsd: number;
  tokens: number;
  avgCostPerAttempt: number;
  avgDurationSec: number | null;
  byStatus: Partial<Record<AttemptStatus, number>>;
}

export interface ReasonCount {
  reason: string;
  count: number;
  lastRunId: string;
}

export interface AnalyticsRunRow {
  runId: string;
  label: string;
  archived: boolean;
  state: RunState;
  stacks: string;
  createdAt: string;
  durationMin: number | null;
  costUsd: number;
  tokens: number;
  fixIterations: number;
  attempts: number;
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
  runRows: AnalyticsRunRow[];
}
