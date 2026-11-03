import { defineStore } from "pinia";
import { api } from "../api.js";
import type { RunSummary } from "../types.js";

interface State {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
}

export interface AttentionItem {
  run: RunSummary;
  kind: "approval" | "paused" | "failed";
  reason: string;
}

const FAILED_ATTENTION_MS = 24 * 60 * 60 * 1000;

export const useRunsStore = defineStore("runs", {
  state: (): State => ({ runs: [], loading: false, error: null }),
  getters: {
    /** Runs waiting on the user: an open approval, a pause, or a failure in the last 24h. Newest first. */
    attention(state): AttentionItem[] {
      const out: AttentionItem[] = [];
      for (const run of state.runs) {
        if (run.pendingApproval) {
          out.push({ run, kind: "approval", reason: `${run.pendingApproval.action}: ${run.pendingApproval.summary}` });
        } else if (run.state === "paused") {
          out.push({ run, kind: "paused", reason: run.pauseReason ?? "paused" });
        } else if (run.state === "failed" && Date.now() - Date.parse(run.updatedAt) < FAILED_ATTENTION_MS) {
          out.push({ run, kind: "failed", reason: run.failureReason ?? "failed" });
        }
      }
      return out.sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt));
    },
  },
  actions: {
    async refresh() {
      this.loading = true;
      this.error = null;
      try {
        const { runs } = await api.listRuns();
        this.runs = runs;
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.loading = false;
      }
    },
  },
});
