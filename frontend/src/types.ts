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

export interface PendingApproval {
  runId: string;
  role: RoleId;
  action: ApprovalAction;
  summary: string;
  payloadPaths: string[];
  requestedAt: string;
}

export interface ProposedBranches {
  perRepo: Array<{ repoPath: string; baseBranch: string; currentBranch: string | null; suggestedBranch: string }>;
}

export interface RepoTarget {
  path: string;
  baseBranch: string;
  aiGuidelinePath: string | null;
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
}

export interface RunDetail extends RunSummary {
  roles: Partial<Record<RoleId, Array<{
    startedAt: string;
    endedAt?: string;
    status: "running" | "done" | "awaiting_approval" | "blocked" | "failed";
    sessionId?: string;
    errorMessage?: string;
  }>>>;
  stateHistory: Array<{ at: string; from: RunState; to: RunState; reason?: string }>;
  artifacts: Array<{ owner: RoleId | "orchestrator"; name: string; relative: string }>;
  failureReason?: string;
}

export type RunEvent =
  | { type: "ws.hello"; runId?: string; scope?: string }
  | { type: "run.created"; runId: string; label: string; repoPaths: string[] }
  | { type: "run.transitioned"; runId: string; from: RunState; to: RunState }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "role.started"; runId: string; role: RoleId; attempt: number }
  | { type: "role.message"; runId: string; role: RoleId; text: string; subtype: "assistant" | "user" | "system" }
  | { type: "role.tool_call"; runId: string; role: RoleId; name: string; input: unknown; toolUseId: string }
  | { type: "role.tool_result"; runId: string; role: RoleId; toolUseId: string; isError: boolean; summary: string }
  | { type: "role.ended"; runId: string; role: RoleId; status: "done" | "awaiting_approval" | "blocked" | "failed"; artifacts: string[] }
  | { type: "approval.requested"; runId: string; role: RoleId; action: string; summary: string; payloadPaths: string[] }
  | { type: "approval.resolved"; runId: string; role: RoleId; action: string; decision: "approve" | "reject" | "edit" | "skip" };
