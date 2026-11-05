import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.js";
import type { AttemptUsage, Overlap, RoleId, RunState } from "./orchestrator/types.js";

export type RunEvent =
  | { type: "run.created"; runId: string; label: string; repoPaths: string[] }
  | { type: "run.transitioned"; runId: string; from: RunState; to: RunState }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "role.started"; runId: string; role: RoleId; attempt: number }
  /** Waiting for a concurrency slot; `position` is 1-based in the global queue. */
  | { type: "role.queued"; runId: string; role: RoleId; position: number }
  | { type: "role.message"; runId: string; role: RoleId; text: string; subtype: "assistant" | "user" | "system" }
  | { type: "role.tool_call"; runId: string; role: RoleId; name: string; input: unknown; toolUseId: string }
  | { type: "role.tool_result"; runId: string; role: RoleId; toolUseId: string; isError: boolean; summary: string }
  | { type: "role.ended"; runId: string; role: RoleId; status: "done" | "awaiting_approval" | "blocked" | "failed" | "aborted"; artifacts: string[] }
  /** Running token totals for the in-flight attempt; `final` once the SDK reports its result. */
  | { type: "role.usage"; runId: string; role: RoleId; usage: AttemptUsage; costUsd: number; final: boolean }
  /** Files this run changes that another active run on the same repo also changes. */
  | { type: "run.overlaps"; runId: string; overlaps: Overlap[] }
  /** The run was archived or deleted and is gone from the run list. */
  | { type: "run.removed"; runId: string; archived: boolean }
  | { type: "approval.requested"; runId: string; role: RoleId; action: string; summary: string; payloadPaths: string[] }
  | { type: "approval.resolved"; runId: string; role: RoleId; action: string; decision: "approve" | "reject" | "edit" | "skip" };

/** What actually goes out: every event is timestamped; persisted ones carry a per-run sequence number. */
export type StampedEvent = RunEvent & { at: string; seq?: number };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

/*
 * Event log: every event except live (non-final) usage ticks is appended to
 * runs/<runId>/events.jsonl, so the run page can replay a role's stream after
 * a reload or when switching between runs. `seq` lets the UI merge the replay
 * with live WebSocket events without gaps or duplicates.
 */
const seqByRun = new Map<string, number>();
const MAX_FIELD_CHARS = 4000;

function logFile(runId: string): string {
  return join(paths.runsDir, runId, "events.jsonl");
}

function shouldPersist(ev: RunEvent): boolean {
  return !(ev.type === "role.usage" && !ev.final);
}

function nextSeq(runId: string): number {
  let cur = seqByRun.get(runId);
  if (cur === undefined) {
    // First event for this run in this process: continue after what's on disk.
    const file = logFile(runId);
    cur = 0;
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8");
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) cur++;
    }
  }
  seqByRun.set(runId, cur + 1);
  return cur + 1;
}

/** Large tool inputs (e.g. a whole file passed to Write) are truncated in the log. */
function compactForLog(ev: StampedEvent): StampedEvent {
  if (ev.type !== "role.tool_call") return ev;
  const raw = JSON.stringify(ev.input ?? {});
  if (raw.length <= MAX_FIELD_CHARS) return ev;
  return { ...ev, input: { truncated: true, preview: raw.slice(0, MAX_FIELD_CHARS) } };
}

export function emit(ev: RunEvent): void {
  const stamped: StampedEvent = { ...ev, at: new Date().toISOString() };
  if (shouldPersist(ev) && existsSync(join(paths.runsDir, ev.runId))) {
    stamped.seq = nextSeq(ev.runId);
    try {
      appendFileSync(logFile(ev.runId), JSON.stringify(compactForLog(stamped)) + "\n");
    } catch {
      // The log is a convenience; never let it break the run.
    }
  }
  bus.emit("event", stamped);
  bus.emit(`run:${ev.runId}`, stamped);
}

/** Forget a run's sequence counter (its log was moved or deleted). */
export function forgetEventLog(runId: string): void {
  seqByRun.delete(runId);
}

/** The last `limit` persisted events of a run, oldest first. */
export function readEventLog(runId: string, limit = 5000): StampedEvent[] {
  const file = logFile(runId);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const out: StampedEvent[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as StampedEvent);
    } catch {
      // skip a torn last line from a crash
    }
  }
  return out;
}

export function subscribe(runId: string, listener: (ev: StampedEvent) => void): () => void {
  const key = `run:${runId}`;
  bus.on(key, listener);
  return () => bus.off(key, listener);
}

export function subscribeAll(listener: (ev: StampedEvent) => void): () => void {
  bus.on("event", listener);
  return () => bus.off("event", listener);
}
