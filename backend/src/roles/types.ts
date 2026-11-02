import type { JiraAccess } from "../external/jiraMcpConfig.js";
import type { RoleId, RunRecord } from "../orchestrator/types.js";

/**
 * Where file-writing tools (Write/Edit/MultiEdit/NotebookEdit) may write.
 * - `run`: only this run's artifact folder (`runs/<runId>/`).
 * - `repos-and-run`: the run's target repos plus the run's artifact folder.
 */
export type WriteScope = "run" | "repos-and-run";

export interface RoleSpec {
  id: RoleId;
  /** Human-readable name used in prompts and logs. */
  title: string;
  promptFile: string;
  allowedTools: string[];
  bashAllowList: RegExp[];
  /** Extra Bash patterns that depend on run state (e.g. installs after an approval). */
  extraBashAllowList?(record: RunRecord): RegExp[];
  writeScope: WriteScope;
  /** Works in the target repos, so the run's worktrees must exist before it starts. */
  needsWorkspace: boolean;
  /**
   * JIRA MCP tools the role gets when a JIRA MCP server is configured:
   * `issue` = fetch one issue; `read` = fetch, search and other read-only tools.
   * The add-comment tool is never given to a role (the orchestrator posts after approval).
   */
  jiraAccess?: JiraAccess;
  maxTurns?: number;
  cwdFor(record: RunRecord): string;
  buildInput(record: RunRecord, ctx: RoleInputCtx): string;
}

/** Fixed signals the orchestrator passes to a role, rendered by `orchestratorSection`. */
export type OrchestratorSignal =
  /** The backend restarted while this role was running. */
  | "orchestrator_restart"
  /** The user (or review auto-routing) sent the review report back for fixes. */
  | "review_fixes_required"
  /** The user approved creating a Playwright suite. */
  | "create_suite_approved";

export interface RoleInputCtx {
  signal?: OrchestratorSignal;
  /** Free-text feedback typed by the user on an approval card. */
  feedback?: string;
  /** Set when another role handed work back to this one. */
  handoff?: { from: RoleId; notes?: string };
}
