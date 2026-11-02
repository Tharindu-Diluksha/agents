import type { ApprovalAction, PendingApproval, RoleId, RunRecord } from "./types.js";

export function requestApproval(
  record: RunRecord,
  role: RoleId,
  input: { action: ApprovalAction; summary: string; payloadPaths: string[] },
): PendingApproval {
  const pending: PendingApproval = {
    runId: record.runId,
    role,
    action: input.action,
    summary: input.summary,
    payloadPaths: input.payloadPaths,
    requestedAt: new Date().toISOString(),
  };
  record.pendingApproval = pending;
  return pending;
}

export function clearApproval(record: RunRecord): void {
  record.pendingApproval = null;
}
