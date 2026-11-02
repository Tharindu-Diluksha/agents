import { log } from "../log.js";
import { listRuns, saveRun } from "./runStore.js";
import { roleForState } from "./workflow.js";
import { runRoleResume } from "./workflowResume.js";

/**
 * Startup pass: finds runs whose latest attempt was still `running` when the
 * orchestrator died, marks that attempt failed with a recovery note, and
 * re-issues the role. The SDK session itself persists across restarts (its id
 * lives in sessions/<run>/<role>.json), so the resumed role sees its prior
 * context.
 */
export function recoverRuns(): void {
  const runs = listRuns();
  for (const record of runs) {
    const role = roleForState(record.state);
    if (!role) continue;
    const attempts = record.roles[role] ?? [];
    const last = attempts[attempts.length - 1];
    const live = last && (last.status === "running" || last.status === "queued");
    // Also: the run entered this running state but died before the role's
    // attempt started (e.g. while syncing with the base before the PR Creator).
    const enteredAt = [...record.stateHistory].reverse().find((h) => h.to === record.state)?.at;
    const neverStarted = !live && enteredAt !== undefined && (!last || last.startedAt < enteredAt);
    if (!live && !neverStarted) continue;

    if (live) {
      last.status = "failed";
      last.errorMessage = "orchestrator restarted mid-run; resuming via session replay";
      last.endedAt = new Date().toISOString();
      saveRun(record);
    }

    log.info("recovery.resuming", { runId: record.runId, role });
    void runRoleResume(record.runId, role);
  }
}
