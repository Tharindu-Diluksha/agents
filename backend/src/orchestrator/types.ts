export const ROLES = ["analyst", "developer", "reviewer", "tester", "prCreator"] as const;
export type RoleId = (typeof ROLES)[number];

export type RunState =
  | "created"
  | "analyst_running"
  | "awaiting_feature_doc_approval"
  | "awaiting_jira_comment_decision"
  | "developer_planning"
  | "awaiting_plan_approval"
  | "awaiting_branch_names"
  | "developer_implementing"
  | "reviewer_running"
  | "awaiting_review_decision"
  | "tester_running"
  | "awaiting_test_suite_approval"
  | "pr_creator_running"
  | "awaiting_pr_approval"
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
  status: "running" | "done" | "awaiting_approval" | "blocked" | "failed";
  sessionId?: string;
  errorMessage?: string;
  output?: RoleOutput;
}

export interface RepoTarget {
  /** Absolute path to a checked-out working tree. */
  path: string;
  /** Base branch for the PR against this repo. */
  baseBranch: string;
  /** Optional path (relative to `path`) to a project AI guideline document. */
  aiGuidelinePath: string | null;
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
}
