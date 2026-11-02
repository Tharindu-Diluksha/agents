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
    if (!last || last.status !== "running") continue;

    last.status = "failed";
    last.errorMessage = "orchestrator restarted mid-run; resuming via session replay";
    last.endedAt = new Date().toISOString();
    saveRun(record);

    log.info("recovery.resuming", { runId: record.runId, role });
    void runRoleResume(record.runId, role);
  }
}
