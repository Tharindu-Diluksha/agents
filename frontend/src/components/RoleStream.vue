<script setup lang="ts">
import { computed } from "vue";
import type { RunEvent, RoleId } from "../types.js";

const props = defineProps<{
  role: RoleId;
  events: RunEvent[];
}>();

type Entry =
  | { kind: "message"; text: string; subtype: string }
  | { kind: "tool_call"; name: string; input: unknown; toolUseId: string }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; summary: string }
  | { kind: "state"; text: string };

const entries = computed<Entry[]>(() => {
  const out: Entry[] = [];
  for (const ev of props.events) {
    if (!("role" in ev) || ev.role !== props.role) {
      if (ev.type === "run.transitioned") out.push({ kind: "state", text: `→ ${ev.to}` });
      continue;
    }
    if (ev.type === "role.message") out.push({ kind: "message", text: ev.text, subtype: ev.subtype });
    else if (ev.type === "role.tool_call") out.push({ kind: "tool_call", name: ev.name, input: ev.input, toolUseId: ev.toolUseId });
    else if (ev.type === "role.tool_result") out.push({ kind: "tool_result", toolUseId: ev.toolUseId, isError: ev.isError, summary: ev.summary });
    else if (ev.type === "role.started") out.push({ kind: "state", text: `role started (attempt ${ev.attempt})` });
    else if (ev.type === "role.ended") out.push({ kind: "state", text: `role ended: ${ev.status}` });
  }
  return out;
});
</script>

<template>
  <div class="stream">
    <div v-if="entries.length === 0" class="muted" style="padding: 16px">
      Waiting for role output…
    </div>
    <div v-for="(e, i) in entries" :key="i" class="entry">
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
    </div>
  </div>
</template>

<style scoped>
.stream { display: flex; flex-direction: column; gap: 8px; max-height: 70vh; overflow-y: auto; }
.entry { }
.msg pre { margin: 0; white-space: pre-wrap; word-break: break-word; }
.msg.assistant { background: var(--panel); padding: 8px 12px; border-left: 3px solid var(--accent); border-radius: 4px; }
.msg.system { background: var(--panel2); padding: 6px 10px; color: var(--muted); font-style: italic; border-radius: 4px; }
.tool { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 4px 0; }
.tool .input { background: var(--panel2); padding: 6px 10px; border-radius: 4px; max-width: 100%; overflow: auto; }
.tool-result { display: flex; align-items: baseline; gap: 8px; margin-left: 24px; }
.tool-result pre { margin: 0; background: var(--panel2); padding: 6px 10px; border-radius: 4px; max-width: 100%; overflow: auto; }
.tool-result.error pre { border-left: 3px solid var(--danger); }
.state { padding: 4px 0; font-size: 12px; }
</style>
