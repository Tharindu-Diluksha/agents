import type { Analytics, EffortLevel, JiraMcpTestResult, Overlap, RoleId, StackId, RunDetail, RunEvent, RunSource, RunSummary, ServerConfig, Slots, StackProject } from "./types.js";

/** Upload shape for notes + images (base64), see ContextEditor's `toContextUpload`. */
export interface ContextUpload {
  note?: string;
  images?: Array<{ name: string; mediaType: string; data: string; caption?: string }>;
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${detail}`);
  }
  return (await resp.json()) as T;
}

export const api = {
  async listRuns(): Promise<{ runs: RunSummary[] }> {
    return json(await fetch("/api/runs"));
  },
  async getRun(id: string): Promise<RunDetail> {
    return json(await fetch(`/api/runs/${id}`));
  },
  async getConfig(): Promise<ServerConfig> {
    return json(await fetch("/api/config"));
  },
  async getEvents(id: string, limit = 5000): Promise<{ events: RunEvent[] }> {
    return json(await fetch(`/api/runs/${id}/events?limit=${limit}`));
  },
  async refreshOverlaps(id: string): Promise<{ overlaps: Overlap[] }> {
    return json(await fetch(`/api/runs/${id}/overlaps/refresh`, { method: "POST" }));
  },
  async detectStacks(path: string): Promise<{ stacks: StackId[]; projects: StackProject[] }> {
    return json(await fetch(`/api/stacks/detect?path=${encodeURIComponent(path)}`));
  },
  async archiveRun(id: string, force = false): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/archive`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      }),
    );
  },
  async deleteRun(id: string, force = false): Promise<void> {
    await json(await fetch(`/api/runs/${id}${force ? "?force=true" : ""}`, { method: "DELETE" }));
  },
  async getAnalytics(includeArchived: boolean): Promise<Analytics> {
    return json(await fetch(`/api/analytics?archived=${includeArchived}`));
  },
  exportUrl(id: string, format: "json" | "csv"): string {
    return `/api/runs/${id}/export?format=${format}`;
  },
  analyticsCsvUrl(includeArchived: boolean): string {
    return `/api/analytics/export.csv?archived=${includeArchived}`;
  },
  async getSlots(): Promise<Slots> {
    return json(await fetch("/api/slots"));
  },
  async removeWorkspaces(id: string, force: boolean): Promise<{ results: Array<{ repoPath: string; workPath: string; removed: boolean; error?: string }> }> {
    return json(
      await fetch(`/api/runs/${id}/workspaces/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force }),
      }),
    );
  },
  async testJira(): Promise<JiraMcpTestResult> {
    return json(await fetch("/api/jira/test", { method: "POST" }));
  },
  async launchRun(input: {
    source: RunSource;
    repos: Array<{ path: string; baseBranch?: string; aiGuidelinePath?: string; stacks?: StackId[] }>;
    models?: Partial<Record<RoleId, string>>;
    efforts?: Partial<Record<RoleId, EffortLevel>>;
    disabledRoles?: RoleId[];
    context?: ContextUpload;
    workspace?: "worktree" | "in-place";
  }): Promise<{ runId: string }> {
    return json(
      await fetch("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async approve(id: string, input: {
    decision: "approve" | "reject" | "edit" | "skip";
    editedPayload?: string;
    feedback?: string;
  }): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  /** Posts the feature doc's open questions to the run's JIRA ticket; the gate stays open. */
  async postJiraComment(id: string, body: string): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/jira-comment`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }),
    );
  },
  async skip(id: string): Promise<void> {
    await json(await fetch(`/api/runs/${id}/skip`, { method: "POST" }));
  },
  /** Adds notes / images to a run; roles see them from their next attempt. */
  async addAttachments(id: string, context: ContextUpload): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/attachments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      }),
    );
  },
  attachmentUrl(id: string, file: string): string {
    return `/api/runs/${encodeURIComponent(id)}/attachments/${encodeURIComponent(file)}`;
  },
  /** Model / effort for a role's next attempt; null = server default. */
  async setRoleSettings(id: string, role: RoleId, settings: { model: string | null; effort: EffortLevel | null }): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/roles/${role}/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(settings),
      }),
    );
  },
  async jump(id: string, to: RoleId): Promise<void> {
    await json(
      await fetch(`/api/runs/${id}/jump`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      }),
    );
  },
  async abort(id: string): Promise<void> {
    await json(await fetch(`/api/runs/${id}/abort`, { method: "POST" }));
  },
  async getArtifact(id: string, relative: string): Promise<string> {
    const resp = await fetch(`/api/runs/${id}/artifacts/${encodeURI(relative)}`);
    if (!resp.ok) throw new Error(`artifact fetch failed: ${resp.status}`);
    return await resp.text();
  },
};
