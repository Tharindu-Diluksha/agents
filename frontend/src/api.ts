import type { RepoTarget, RoleId, RunDetail, RunSource, RunSummary } from "./types.js";

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
  async launchRun(input: { source: RunSource; repos: Array<{ path: string; baseBranch?: string; aiGuidelinePath?: string }> }): Promise<{ runId: string }> {
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
