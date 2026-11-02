import { EventEmitter } from "node:events";
import type { AttemptUsage, RoleId, RunState } from "./orchestrator/types.js";

export type RunEvent =
  | { type: "run.created"; runId: string; label: string; repoPaths: string[] }
  | { type: "run.transitioned"; runId: string; from: RunState; to: RunState }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "role.started"; runId: string; role: RoleId; attempt: number }
  | { type: "role.message"; runId: string; role: RoleId; text: string; subtype: "assistant" | "user" | "system" }
  | { type: "role.tool_call"; runId: string; role: RoleId; name: string; input: unknown; toolUseId: string }
  | { type: "role.tool_result"; runId: string; role: RoleId; toolUseId: string; isError: boolean; summary: string }
  | { type: "role.ended"; runId: string; role: RoleId; status: "done" | "awaiting_approval" | "blocked" | "failed" | "aborted"; artifacts: string[] }
  /** Running token totals for the in-flight attempt; `final` once the SDK reports its result. */
  | { type: "role.usage"; runId: string; role: RoleId; usage: AttemptUsage; costUsd: number; final: boolean }
  | { type: "approval.requested"; runId: string; role: RoleId; action: string; summary: string; payloadPaths: string[] }
  | { type: "approval.resolved"; runId: string; role: RoleId; action: string; decision: "approve" | "reject" | "edit" | "skip" };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(ev: RunEvent): void {
  bus.emit("event", ev);
  bus.emit(`run:${ev.runId}`, ev);
}

export function subscribe(runId: string, listener: (ev: RunEvent) => void): () => void {
  const key = `run:${runId}`;
  bus.on(key, listener);
  return () => bus.off(key, listener);
}

export function subscribeAll(listener: (ev: RunEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
