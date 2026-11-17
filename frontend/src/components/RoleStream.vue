<script setup lang="ts">
import { computed, reactive } from "vue";
import { formatUsd, type RoleAttempt, type RunEvent, type RoleId } from "../types.js";
import { groupByAttempt, type Group } from "../streamGroups.js";

const props = defineProps<{
  role: RoleId;
  events: RunEvent[];
  /** The role's attempts from run.json (status, phase, cost), matched to the stream by attempt number. */
  attempts?: RoleAttempt[];
}>();

const groups = computed<Group[]>(() => groupByAttempt(props.events, props.role));

const PHASES: Record<string, string> = {
  developer_planning: "planning",
  developer_implementing: "implementing",
  unit_tests_red_running: "red (failing tests)",
  unit_tests_green_running: "green (verify)",
};

function meta(g: Group): { status: string; cls: string; phase: string | null; started: string | null; cost: string | null; feedback: boolean } {
  const a = props.attempts?.[g.attempt - 1];
  const status = a?.status ?? g.endStatus ?? (g.ended ? "ended" : "running");
  const cls =
    status === "running" ? "running" : status === "queued" || status === "awaiting_approval" ? "awaiting" : status === "done" ? "done" : status === "failed" ? "failed" : status === "blocked" ? "warn" : "idle";
  return {
    status: status.replace(/_/g, " "),
    cls,
    phase: a?.state ? PHASES[a.state] ?? null : null,
    started: a?.startedAt ? new Date(a.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null,
    cost: a?.costUsd ? formatUsd(a.costUsd) : null,
    feedback: Boolean(a?.feedback),
  };
}

/** Open/closed per attempt, set by the user; by default only the newest attempt is open. */
const toggled = reactive<Record<string, boolean>>({});
const key = (g: Group) => `${props.role}:${g.attempt}`;
function isOpen(g: Group, i: number): boolean {
  return toggled[key(g)] ?? i === 0;
}
function onToggle(g: Group, e: Event) {
  toggled[key(g)] = (e.target as HTMLDetailsElement).open;
}
</script>

<template>
  <div class="stream">
    <div v-if="groups.length === 0" class="muted" style="padding: 16px">
      Waiting for role output…
    </div>
    <details v-for="(g, i) in groups" :key="key(g)" class="attempt" :open="isOpen(g, i)" @toggle="onToggle(g, $event)">
      <summary>
        <strong>Attempt {{ g.attempt }}</strong>
        <span v-if="meta(g).phase" class="muted">· {{ meta(g).phase }}</span>
        <span class="chip" :class="meta(g).cls">{{ meta(g).status }}</span>
        <span v-if="meta(g).feedback" class="chip" title="Started with your answers / feedback">with feedback</span>
        <span class="spacer" />
        <span v-if="meta(g).cost" class="muted mono small">{{ meta(g).cost }}</span>
        <span v-if="meta(g).started" class="muted small">{{ meta(g).started }}</span>
        <span v-if="i === 0 && groups.length > 1" class="muted small">latest</span>
      </summary>
      <div class="entries">
        <div v-for="(e, j) in g.entries" :key="j" class="entry">
          <template v-if="e.kind === 'message'">
            <div class="msg" :class="e.subtype">
              <pre>{{ e.text }}</pre>
            </div>
          </template>
          <template v-else-if="e.kind === 'tool_call'">
            <div class="tool">
              <span class="chip running">tool</span>
              <span class="mono">{{ e.name }}</span>
              <pre class="mono input">{{ JSON.stringify(e.input, null, 2) }}</pre>
            </div>
          </template>
          <template v-else-if="e.kind === 'tool_result'">
            <div class="tool-result" :class="{ error: e.isError }">
              <span class="chip" :class="e.isError ? 'failed' : 'done'">result</span>
              <pre class="mono">{{ e.summary }}</pre>
            </div>
          </template>
          <template v-else-if="e.kind === 'state'">
            <div class="state muted">{{ e.text }}</div>
          </template>
          <template v-else-if="e.kind === 'transition'">
            <div class="transition" :class="{ gate: e.gate }">
              <span class="arrow">→</span> {{ e.text }}
            </div>
          </template>
        </div>
      </div>
    </details>
  </div>
</template>

<style scoped>
.stream { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; overflow-x: hidden; min-width: 0; }
.attempt { border: 1px solid var(--border); border-radius: 6px; min-width: 0; }
.attempt[open] { border-color: var(--accent); }
.attempt > summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 6px 10px; cursor: pointer; background: var(--panel2); border-radius: 6px; list-style: none; }
.attempt > summary::-webkit-details-marker { display: none; }
.attempt > summary::before { content: "▸"; color: var(--muted); }
.attempt[open] > summary::before { content: "▾"; }
.attempt[open] > summary { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.spacer { flex: 1; }
.small { font-size: 11px; }
.entries { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; min-width: 0; }
.entry { min-width: 0; }
.msg pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.msg.assistant { background: var(--panel); padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: 4px; }
.msg.system { background: var(--panel2); padding: 6px 10px; color: var(--muted); font-style: italic; border-radius: 4px; }
.tool { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.tool .input { background: var(--panel2); padding: 6px 10px; border-radius: 4px; max-width: 100%; min-width: 0; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.tool-result { display: flex; align-items: baseline; gap: 8px; margin-left: 24px; min-width: 0; }
.tool-result pre { margin: 0; background: var(--panel2); padding: 6px 10px; border-radius: 4px; flex: 1 1 auto; min-width: 0; max-width: 100%; max-height: 300px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
.tool-result.error pre { border-left: 3px solid var(--danger); }
.state { padding: 4px 0; font-size: 12px; }
.transition { align-self: flex-start; font-size: 12px; padding: 3px 10px; border: 1px solid var(--accent); border-radius: 999px; color: var(--accent); }
.transition.gate { border-color: var(--warn); color: var(--warn); }
.transition .arrow { font-weight: bold; }
</style>
