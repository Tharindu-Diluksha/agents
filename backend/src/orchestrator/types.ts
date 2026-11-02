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

export type RunState =
  | "created"
  | "analyst_running"
  | "awaiting_feature_doc_approval"
  | "awaiting_jira_comment_decision"
  | "developer_planning"
  | "awaiting_plan_approval"
  | "awaiting_branch_names"
  /** Unit Tester writes failing tests from the plan (TDD red). */
  | "unit_tests_red_running"
  | "developer_implementing"
  /** Unit Tester verifies the Developer's change turned its tests green. */
  | "unit_tests_green_running"
  | "integration_tester_running"
  | "reviewer_running"
  | "awaiting_review_decision"
  | "e2e_tester_running"
  | "awaiting_test_suite_approval"
  | "pr_creator_running"
  | "awaiting_pr_approval"
  /** Stopped by the user, by the fix-loop cap, or by the cost budget. Resume with "jump to role". */
  | "paused"
  | "done"
  | "failed";

export type ApprovalAction =
  | "post_jira_comment"
  | "create_test_suite"
  | "create_pr"
  | "approve_branch_names"
  | "proceed_to_next";

export interface RoleOutput {
  status: "done" | "awaiting_approval" | "blocked";
  artifacts: string[];
  approvalRequest: {
    action: ApprovalAction;
    summary: string;
    /** One payload path per sub-action (e.g. one PR description per repo). Empty if the approval has no payload. */
    payloadPaths: string[];
  } | null;
  handoff: {
    nextRole: RoleId;
    notes?: string;
  } | null;
}

export interface PendingApproval {
  runId: string;
  role: RoleId;
  action: ApprovalAction;
  summary: string;
  payloadPaths: string[];
  requestedAt: string;
}

export interface RoleAttempt {
  startedAt: string;
  endedAt?: string;
  /** `queued` = preparing the workspace or waiting for a free concurrency slot. */
  status: "queued" | "running" | "done" | "awaiting_approval" | "blocked" | "failed" | "aborted";
  /** Run state when the attempt started — distinguishes e.g. unit-test red vs green phases. */
  state?: RunState;
  sessionId?: string;
  errorMessage?: string;
  output?: RoleOutput;
  /** Model id the attempt ran with. */
  model?: string;
  /** Cost and usage reported by the SDK's `result` message. */
  costUsd?: number;
  numTurns?: number;
  usage?: AttemptUsage;
}

export interface AttemptUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface RepoTarget {
  /** Absolute path to a checked-out working tree. */
  path: string;
  /** Base branch for the PR against this repo. */
  baseBranch: string;
  /** Optional path (relative to `path`) to a project AI guideline document. */
  aiGuidelinePath: string | null;
  /**
   * The run's own git worktree for this repo, once created. Roles work here,
   * never in `path` (the user's checkout). Null/absent before the Developer's
   * first session, or after the worktree was removed.
   */
  workPath?: string | null;
  /** Feature branch for this repo, once the user approved it. */
  branch?: string | null;
  /** Ref the worktree started from (`origin/<base>` or `<base>`); diffs compare against it. */
  baseRef?: string | null;
}

export type SourceType = "feature" | "change" | "fix";

export interface JiraSource {
  kind: "jira";
  ticket: string;        // e.g. "PROJ-123"
  ticketUrl: string;     // canonical browse URL
}

export interface ManualSource {
  kind: "manual";
  type: SourceType;
  title: string;
  description: string;             // free-form (markdown ok)
  acceptanceCriteria: string[];    // one entry per criterion
}

export type RunSource = JiraSource | ManualSource;

export interface RunRecord {
  runId: string;
  /** Human-visible label — JIRA key for jira source, truncated title for manual. */
  label: string;
  source: RunSource;
  /** One or more target repos — a single feature can span multiple. The first entry is the "primary" cwd for SDK sessions. */
  repos: RepoTarget[];
  state: RunState;
  createdAt: string;
  updatedAt: string;
  roles: Partial<Record<RoleId, RoleAttempt[]>>;
  stateHistory: Array<{ at: string; from: RunState; to: RunState; reason?: string }>;
  pendingApproval: PendingApproval | null;
  failureReason?: string;
  /** Why the run is in the `paused` state. */
  pauseReason?: string;
  /** Per-run model overrides; roles not listed use `config.models`. */
  models?: Partial<Record<RoleId, string>>;
  /** Number of fix loops (review rejection or a tester handing back to the Developer) so far. */
  fixIterations?: number;
  /**
   * `worktree`: each repo gets an isolated git worktree for this run (default).
   * `in-place`: roles work in the user's checkout (runs created before worktrees).
   */
  workspace?: "worktree" | "in-place";
}
