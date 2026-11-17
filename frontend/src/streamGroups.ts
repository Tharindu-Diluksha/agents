import { STATE_LABELS, type RoleId, type RunEvent } from "./types.js";

export type Entry =
  | { kind: "message"; text: string; subtype: string }
  | { kind: "tool_call"; name: string; input: unknown; toolUseId: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "state"; text: string }
  /** The run moved to another state, e.g. "Developer implementing" after this role finished. */
  | { kind: "transition"; text: string; gate: boolean };

export interface Group {
  /** 1-based attempt number (from role.started, else inferred). */
  attempt: number;
  entries: Entry[];
  ended: boolean;
  endStatus?: string;
}

/**
 * Splits the role's events into one group per attempt. A group closes at the
 * role's `role.ended`; the next role-specific event opens the next one. Run
 * transitions between attempts (e.g. "→ developer_implementing") move into the
 * attempt that follows them, or stay with the last one if none follows.
 */
export function groupByAttempt(events: RunEvent[], role: RoleId): Group[] {
  const out: Group[] = [];
  let current: Group | null = null;
  let between: Entry[] = [];

  const open = (attempt?: number): Group => {
    const g: Group = { attempt: attempt ?? (out.length ? out[out.length - 1]!.attempt + 1 : 1), entries: between, ended: false };
    between = [];
    out.push(g);
    return g;
  };

  for (const ev of events) {
    if (!("role" in ev) || ev.role !== role) {
      if (ev.type === "run.transitioned") {
        const e: Entry = { kind: "transition", text: STATE_LABELS[ev.to] ?? ev.to, gate: ev.to.startsWith("awaiting_") };
        if (current && !current.ended) current.entries.push(e);
        else between.push(e);
      }
      continue;
    }
    if (ev.type === "role.started") {
      // The attempt may already be open from queue/workspace messages sent before it started.
      if (!current || current.ended) current = open(ev.attempt);
      else current.attempt = ev.attempt;
      current.entries.push({ kind: "state", text: `role started (attempt ${ev.attempt})` });
      continue;
    }
    if (!current || current.ended) current = open();
    if (ev.type === "role.message") current.entries.push({ kind: "message", text: ev.text, subtype: ev.subtype });
    else if (ev.type === "role.tool_call") current.entries.push({ kind: "tool_call", name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
    else if (ev.type === "role.tool_result") current.entries.push({ kind: "tool_result", toolUseId: ev.toolUseId, isError: ev.isError, summary: ev.summary });
    else if (ev.type === "role.ended") {
      current.entries.push({ kind: "state", text: `role ended: ${ev.status}` });
      current.ended = true;
      current.endStatus = ev.status;
    }
  }
  // Transitions after the last attempt stay with it; a role that never ran shows no attempt at all.
  if (between.length && out.length) out[out.length - 1]!.entries.push(...between);
  return out.reverse(); // newest first
}
