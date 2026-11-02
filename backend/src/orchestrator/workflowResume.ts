import { loadRun } from "./runStore.js";
import { runRoleViaWorkflow } from "./workflow.js";
import type { RoleId } from "./types.js";

/**
 * Thin re-entry point used by the startup recovery pass. We funnel through
 * `workflow.ts` so the state machine's bookkeeping (startAttempt,
 * event emission, transition on output) stays consistent.
 */
export async function runRoleResume(runId: string, role: RoleId): Promise<void> {
  const record = loadRun(runId);
  if (!record) return;
  await runRoleViaWorkflow(record, role, "orchestrator_restart");
}
