import type { JiraMcpTestResult, Overlap, RoleId, StackId, RunDetail, RunEvent, RunSource, RunSummary, ServerConfig, Slots } from "./types.js";

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
  async detectStacks(path: string): Promise<{ stacks: StackId[] }> {
    return json(await fetch(`/api/stacks/detect?path=${encodeURIComponent(path)}`));
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
  async skip(id: string): Promise<void> {
    await json(await fetch(`/api/runs/${id}/skip`, { method: "POST" }));
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
