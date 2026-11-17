import type { StackId, StackProject } from "../stacks.js";
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

/** Reasoning effort levels the Agent SDK accepts (`effort` option). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Roles every run must include; the others can be turned off at launch. */
export const REQUIRED_ROLES: readonly RoleId[] = ["analyst", "developer", "reviewer"];

export type RunState =
  | "created"
  | "analyst_running"
  | "awaiting_feature_doc_approval"
  /** Legacy: runs from before open questions moved to the feature-doc gate. Resolving it reopens that gate. */
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
  /** Reasoning effort the attempt ran with; absent = the model's default. */
  effort?: EffortLevel;
  /** Cost and usage reported by the SDK's `result` message. */
  costUsd?: number;
  numTurns?: number;
  usage?: AttemptUsage;
  /** Answers / feedback the user sent from an approval card to start this attempt. */
  feedback?: string;
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
   * Repo-relative instruction files for AI agents (CLAUDE.md, AGENTS.md) inlined
   * into the prompts of the roles in `PROJECT_INSTRUCTION_ROLES`. Recorded at
   * launch (detected, or chosen in the dialog); [] = none. Absent (older runs) =
   * `DEFAULT_INSTRUCTION_FILES`, whichever exist.
   */
  instructionFiles?: string[];
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
  /** Tech stacks of this repo, primary first (detected at launch or chosen). Absent = TypeScript (older runs). */
  stacks?: StackId[];
  /**
   * Where each stack lives in the repo (root "." or a top-level folder of a
   * monorepo). Absent = every stack at the root (runs before monorepo support).
   */
  projects?: StackProject[];
  /** False while (or after a failed) dependency install into the worktree; retried on next use. */
  depsInstalled?: boolean;
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
  /** Per-run reasoning-effort overrides; roles not listed use `config.efforts` (or the model's default). */
  efforts?: Partial<Record<RoleId, EffortLevel>>;
  /**
   * Optional roles turned off at launch (never one of `REQUIRED_ROLES`). The
   * state machine skips their states; absent = every role runs.
   */
  disabledRoles?: RoleId[];
  /** Number of fix loops (review rejection or a tester handing back to the Developer) so far. */
  fixIterations?: number;
  /**
   * `worktree`: each repo gets an isolated git worktree for this run (default).
   * `in-place`: "branch" mode, chosen at launch (and every run created before
   *   worktrees): roles work in the user's checkout, and the branch gate
   *   creates the feature branch there off the latest base. One such run per
   *   repo at a time; no per-run dependency install or port block.
   */
  workspace?: "worktree" | "in-place";
  /** Ports reserved for this run's dev/test servers while its worktrees exist. */
  ports?: PortBlock | null;
  /** Last computed file overlaps with other active runs. */
  overlaps?: Overlap[];
  /** Pull requests the orchestrator opened for this run, one per repo. */
  pullRequests?: PullRequestLink[];
  /** Extra notes and images (e.g. mockups not in JIRA) the user added at launch or later; shown to every role. */
  attachments?: RunAttachment[];
  /** Comments the orchestrator posted to the JIRA ticket (open questions the user couldn't answer). */
  jiraComments?: JiraCommentRecord[];
}

export interface JiraCommentRecord {
  postedAt: string;
  ticket: string;
  /** Number of open questions in the feature doc when the comment was posted. */
  openQuestions: number;
}

/**
 * User-supplied context. A note's text lives here; an image's bytes live in
 * runs/<runId>/attachments/<file>.
 */
export interface RunAttachment {
  id: string;
  kind: "note" | "image";
  addedAt: string;
  /** Run state when it was added ("created" = launch dialog). */
  stage: RunState;
  /** Note body (kind = note) or optional caption (kind = image). */
  text?: string;
  /** Image file name inside the run's attachments folder. */
  file?: string;
  /** The image's original file name, for display. */
  originalName?: string;
  mediaType?: string;
}

export interface PullRequestLink {
  repoPath: string;
  url: string;
}

/** Files changed by this run that another active run on the same repo also changes. */
export interface Overlap {
  otherRunId: string;
  otherLabel: string;
  repoPath: string;
  files: string[];
}

/** Ports reserved for one run: [base, base + count). Passed to role sessions as env vars. */
export interface PortBlock {
  base: number;
  count: number;
}
