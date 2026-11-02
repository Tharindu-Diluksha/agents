<script setup lang="ts">
import { computed } from "vue";
import {
  addUsage,
  emptyUsage,
  formatTokens,
  formatUsd,
  ROLE_LABELS,
  ROLES,
  totalTokens,
  type AttemptUsage,
  type RoleId,
  type RunDetail,
} from "../types.js";

/**
 * Token usage per role. Finished attempts come from run.json; a running
 * attempt shows the live totals streamed as `role.usage` events.
 */
const props = defineProps<{
  detail: RunDetail;
  live: Partial<Record<RoleId, { usage: AttemptUsage; costUsd: number }>>;
}>();

interface Row {
  role: RoleId;
  attempts: number;
  models: string;
  usage: AttemptUsage;
  costUsd: number;
  running: boolean;
}

const rows = computed<Row[]>(() =>
  ROLES.map((role) => {
    const attempts = props.detail.roles[role] ?? [];
    let usage = emptyUsage();
    let costUsd = 0;
    for (const a of attempts) {
      usage = addUsage(usage, a.usage);
      costUsd += a.costUsd ?? 0;
    }
    const last = attempts[attempts.length - 1];
    const running = last?.status === "running";
    const live = props.live[role];
    if (running && live) {
      usage = addUsage(usage, live.usage);
      costUsd += live.costUsd;
    }
    const models = [...new Set(attempts.map((a) => a.model).filter((m): m is string => Boolean(m)))];
    return {
      role,
      attempts: attempts.length,
      models: models.join(", ") || props.detail.effectiveModels[role],
      usage,
      costUsd,
      running,
    };
  }).filter((r) => r.attempts > 0),
);

const total = computed(() => {
  let usage = emptyUsage();
  let costUsd = 0;
  for (const r of rows.value) {
    usage = addUsage(usage, r.usage);
    costUsd += r.costUsd;
  }
  return { usage, costUsd };
});

const fmt = (n: number) => n.toLocaleString();
</script>

<template>
  <section class="panel">
    <h3 style="margin: 0 0 8px">Token usage</h3>
    <p v-if="rows.length === 0" class="muted">No role has run yet.</p>
    <div v-else class="table-wrap">
      <table class="usage">
        <thead>
          <tr>
            <th>Role</th>
            <th>Model</th>
            <th class="num">Attempts</th>
            <th class="num" title="Uncached input tokens">Input</th>
            <th class="num">Output</th>
            <th class="num" title="Input tokens served from the prompt cache">Cache read</th>
            <th class="num" title="Input tokens written to the prompt cache">Cache write</th>
            <th class="num">Total</th>
            <th class="num">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.role">
            <td>
              {{ ROLE_LABELS[r.role] }}
              <span v-if="r.running" class="chip running" style="margin-left: 4px">live</span>
            </td>
            <td class="mono muted">{{ r.models }}</td>
            <td class="num">{{ r.attempts }}</td>
            <td class="num mono" :title="fmt(r.usage.inputTokens)">{{ formatTokens(r.usage.inputTokens) }}</td>
            <td class="num mono" :title="fmt(r.usage.outputTokens)">{{ formatTokens(r.usage.outputTokens) }}</td>
            <td class="num mono" :title="fmt(r.usage.cacheReadInputTokens)">{{ formatTokens(r.usage.cacheReadInputTokens) }}</td>
            <td class="num mono" :title="fmt(r.usage.cacheCreationInputTokens)">{{ formatTokens(r.usage.cacheCreationInputTokens) }}</td>
            <td class="num mono" :title="fmt(totalTokens(r.usage))">{{ formatTokens(totalTokens(r.usage)) }}</td>
            <td class="num mono">{{ formatUsd(r.costUsd) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <td colspan="3"><strong>Total</strong></td>
            <td class="num mono" :title="fmt(total.usage.inputTokens)">{{ formatTokens(total.usage.inputTokens) }}</td>
            <td class="num mono" :title="fmt(total.usage.outputTokens)">{{ formatTokens(total.usage.outputTokens) }}</td>
            <td class="num mono" :title="fmt(total.usage.cacheReadInputTokens)">{{ formatTokens(total.usage.cacheReadInputTokens) }}</td>
            <td class="num mono" :title="fmt(total.usage.cacheCreationInputTokens)">{{ formatTokens(total.usage.cacheCreationInputTokens) }}</td>
            <td class="num mono" :title="fmt(totalTokens(total.usage))"><strong>{{ formatTokens(totalTokens(total.usage)) }}</strong></td>
            <td class="num mono"><strong>{{ formatUsd(total.costUsd) }}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
    <p class="muted" style="font-size: 11px; margin: 8px 0 0">
      Counts include every attempt and retry of a role. Hover a number for the exact value.
    </p>
  </section>
</template>

<style scoped>
.table-wrap { overflow-x: auto; }
table.usage { width: 100%; border-collapse: collapse; font-size: 13px; }
table.usage th, table.usage td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
table.usage th { color: var(--muted); font-weight: 500; }
table.usage .num { text-align: right; }
table.usage tfoot td { border-bottom: none; border-top: 1px solid var(--border); }
</style>
