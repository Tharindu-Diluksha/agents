import { defineStore } from "pinia";
import { api } from "../api.js";
import type { RunSummary } from "../types.js";

interface State {
  runs: RunSummary[];
  loading: boolean;
  error: string | null;
}

export const useRunsStore = defineStore("runs", {
  state: (): State => ({ runs: [], loading: false, error: null }),
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
