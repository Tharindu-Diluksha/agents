<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import { formatTokens, formatUsd, ROLE_LABELS, stateChipClass, type Analytics } from "../types.js";

const includeArchived = ref(true);
const data = ref<Analytics | null>(null);
const err = ref<string | null>(null);

async function load() {
  err.value = null;
  try {
    data.value = await api.getAnalytics(includeArchived.value);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(load);
watch(includeArchived, load);

const maxRoleCost = computed(() => Math.max(0.0001, ...(data.value?.roles.map((r) => r.costUsd) ?? [0])));
const fmtMin = (m: number | null) => (m === null ? "—" : m < 60 ? `${m.toFixed(0)} min` : `${(m / 60).toFixed(1)} h`);
const fmtSec = (s: number | null) => (s === null ? "—" : s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`);
const statusText = (by: Record<string, number | undefined>) =>
  Object.entries(by)
    .filter(([, n]) => n)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ") || "—";
</script>

<template>
  <div class="page">
    <div class="row">
      <h2 style="margin: 0">Analytics</h2>
      <label class="muted" style="font-size: 13px; display: flex; gap: 6px; align-items: center">
        <input type="checkbox" v-model="includeArchived" style="width: auto" /> include archived runs
      </label>
      <div class="spacer" />
      <a :href="api.analyticsCsvUrl(includeArchived)" download>Download all attempts (CSV)</a>
    </div>
    <p class="muted" style="margin: 4px 0 0; font-size: 13px">
      Across every run on this machine: where the cost goes, how often work loops back, and why runs stop. Use the per-role table to decide which role prompt to improve next.
    </p>

    <p v-if="err" class="error">{{ err }}</p>
    <p v-else-if="!data" class="muted">Loading…</p>
    <template v-else>
      <p v-if="data.runs === 0" class="panel muted">No runs yet.</p>
      <template v-else>
        <div class="tiles">
          <div class="tile panel"><div class="muted">Runs</div><div class="big">{{ data.runs }}</div>
            <div class="muted small"><span v-for="(n, s) in data.byState" :key="s" class="chip" :class="stateChipClass(s)" style="margin: 2px">{{ s }} {{ n }}</span></div>
          </div>
          <div class="tile panel"><div class="muted">Total cost</div><div class="big">{{ formatUsd(data.costUsd) }}</div><div class="muted small">{{ formatTokens(data.tokens) }} tokens</div></div>
          <div class="tile panel"><div class="muted">Avg cost per finished run</div><div class="big">{{ data.avgCostPerDoneRun === null ? "—" : formatUsd(data.avgCostPerDoneRun) }}</div></div>
          <div class="tile panel"><div class="muted">Median time to done</div><div class="big">{{ fmtMin(data.medianDoneDurationMin) }}</div></div>
          <div class="tile panel"><div class="muted">Avg fix loops per run</div><div class="big">{{ data.avgFixIterations === null ? "—" : data.avgFixIterations.toFixed(1) }}</div></div>
        </div>

        <section class="panel">
          <h3>Per role</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Role</th><th class="num">Attempts</th><th>Cost share</th><th class="num">Cost</th><th class="num">Avg / attempt</th><th class="num">Tokens</th><th class="num">Avg duration</th><th>Outcomes</th></tr></thead>
              <tbody>
                <tr v-for="r in data.roles" :key="r.role">
                  <td>{{ ROLE_LABELS[r.role] }}</td>
                  <td class="num">{{ r.attempts }}</td>
                  <td><div class="bar"><div :style="{ width: `${(r.costUsd / maxRoleCost) * 100}%` }" /></div></td>
                  <td class="num mono">{{ formatUsd(r.costUsd) }}</td>
                  <td class="num mono">{{ r.attempts ? formatUsd(r.avgCostPerAttempt) : "—" }}</td>
                  <td class="num mono">{{ formatTokens(r.tokens) }}</td>
                  <td class="num">{{ fmtSec(r.avgDurationSec) }}</td>
                  <td class="muted small">{{ statusText(r.byStatus) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div class="two">
          <section class="panel">
            <h3>Why runs paused</h3>
            <p v-if="!data.pauseReasons.length" class="muted">None.</p>
            <ol v-else><li v-for="r in data.pauseReasons" :key="r.reason"><strong>{{ r.count }}×</strong> {{ r.reason }} <RouterLink :to="`/runs/${r.lastRunId}`" class="small">latest</RouterLink></li></ol>
          </section>
          <section class="panel">
            <h3>Why runs failed</h3>
            <p v-if="!data.failureReasons.length" class="muted">None.</p>
            <ol v-else><li v-for="r in data.failureReasons" :key="r.reason"><strong>{{ r.count }}×</strong> {{ r.reason }} <RouterLink :to="`/runs/${r.lastRunId}`" class="small">latest</RouterLink></li></ol>
          </section>
        </div>

        <section class="panel">
          <h3>Runs</h3>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Run</th><th>State</th><th>Stacks</th><th class="num">Duration</th><th class="num">Attempts</th><th class="num">Fix loops</th><th class="num">Tokens</th><th class="num">Cost</th><th>Export</th></tr></thead>
              <tbody>
                <tr v-for="r in data.runRows" :key="r.runId">
                  <td>
                    <RouterLink v-if="!r.archived" :to="`/runs/${r.runId}`">{{ r.label }}</RouterLink>
                    <span v-else>{{ r.label }} <span class="chip idle">archived</span></span>
                    <div class="muted mono small">{{ r.runId }}</div>
                  </td>
                  <td><span class="chip" :class="stateChipClass(r.state)">{{ r.state }}</span></td>
                  <td class="mono small">{{ r.stacks }}</td>
                  <td class="num">{{ fmtMin(r.durationMin) }}</td>
                  <td class="num">{{ r.attempts }}</td>
                  <td class="num">{{ r.fixIterations }}</td>
                  <td class="num mono">{{ formatTokens(r.tokens) }}</td>
                  <td class="num mono">{{ formatUsd(r.costUsd) }}</td>
                  <td class="small"><a :href="api.exportUrl(r.runId, 'csv')" download>CSV</a> · <a :href="api.exportUrl(r.runId, 'json')" download>JSON</a></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 16px; }
h3 { margin: 0 0 8px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
.tile .big { font-size: 22px; font-weight: 600; margin-top: 2px; }
.small { font-size: 11px; }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
@media (max-width: 900px) { .two { grid-template-columns: 1fr; } }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
.num { text-align: right; }
.bar { width: 140px; height: 8px; background: var(--panel2); border-radius: 4px; overflow: hidden; }
.bar > div { height: 100%; background: var(--accent); }
ol { margin: 0; padding-left: 20px; }
li { margin: 4px 0; font-size: 13px; }
.error { color: var(--danger); }
</style>
