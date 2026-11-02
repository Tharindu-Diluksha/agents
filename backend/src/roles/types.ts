import type { RoleId, RunRecord } from "../orchestrator/types.js";

export interface RoleSpec {
  id: RoleId;
  promptFile: string;
  allowedTools: string[];
  bashAllowList: RegExp[];
  maxTurns?: number;
  cwdFor(record: RunRecord): string;
  buildInput(record: RunRecord, ctx: { feedback?: string }): string;
}
