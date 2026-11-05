<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { api } from "../api.js";
import { can, needs } from "../auth.js";
import { useRouter } from "vue-router";
import { useRunsStore } from "../stores/runs.js";
import LaunchRunDialog from "./LaunchRunDialog.vue";
import { formatTokens, formatUsd, stateChipClass, totalTokens, type Slots } from "../types.js";

const store = useRunsStore();
const router = useRouter();
const showDialog = ref(false);

// Global role-session slots, shared by all runs (MAX_CONCURRENT_ROLES).
const slots = ref<Slots | null>(null);
async function refreshSlots() {
  try {
    slots.value = await api.getSlots();
  } catch {
    slots.value = null;
  }
}
// The run list itself is kept fresh by the app-wide event socket (useAttention).
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  store.refresh();
  refreshSlots();
  timer = setInterval(refreshSlots, 5000);
});
onUnmounted(() => clearInterval(timer));

function onLaunched(runId: string) {
  showDialog.value = false;
  router.push(`/runs/${runId}`);
}
</script>

<template>
  <div>
    <div class="row">
      <h2>Runs</h2>
      <span v-if="slots" class="chip" :class="slots.queued > 0 ? 'awaiting' : 'idle'" title="Role sessions running across all runs (MAX_CONCURRENT_ROLES)">
        {{ slots.running }}/{{ slots.limit > 0 ? slots.limit : "∞" }} roles running<template v-if="slots.queued">, {{ slots.queued }} queued</template>
      </span>
      <div class="spacer" />
      <button class="primary" @click="showDialog = true" :disabled="!can('operator')" :title="needs('operator')">Launch new run</button>
      <button @click="store.refresh()" :disabled="store.loading">Refresh</button>
    </div>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <section v-if="store.attention.length" class="panel attention">
      <h3 style="margin: 0 0 6px">Needs your attention</h3>
      <div v-for="item in store.attention" :key="item.run.runId" class="attention-row">
        <span class="chip" :class="item.kind === 'failed' ? 'failed' : item.kind === 'paused' ? 'paused' : 'awaiting'">
          {{ item.kind === "approval" ? "approval" : item.kind }}
        </span>
        <RouterLink :to="`/runs/${item.run.runId}`">{{ item.run.label }}</RouterLink>
        <span class="muted reason">{{ item.reason }}</span>
      </div>
    </section>

    <div v-if="store.runs.length === 0" class="panel muted" style="text-align:center">
      No runs yet. Launch one with a JIRA ticket URL and the absolute path to the target repo.
    </div>

    <table v-else class="runs">
      <thead>
        <tr>
          <th>Source</th>
          <th>State</th>
          <th>Repos</th>
          <th>Usage</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in store.runs" :key="r.runId">
          <td>
            <RouterLink :to="`/runs/${r.runId}`">{{ r.label }}</RouterLink>
            <div v-if="r.source.kind === 'jira'" class="muted" style="font-size:12px">jira · {{ r.source.ticket }}</div>
            <div v-else class="muted" style="font-size:12px">{{ r.source.type }} · {{ r.source.title }}</div>
            <div class="muted mono" style="font-size:11px">{{ r.runId }}</div>
            <div v-if="r.createdBy" class="muted" style="font-size:11px">by {{ r.createdBy.name }}</div>
          </td>
          <td>
            <span class="chip" :class="stateChipClass(r.state)">{{ r.state }}</span>
            <div v-if="r.overlaps?.length" style="margin-top: 4px">
              <span class="chip awaiting" :title="r.overlaps.map((o) => `${o.otherLabel}: ${o.files.join(', ')}`).join('\n')">
                overlaps {{ r.overlaps.map((o) => o.otherLabel).join(", ") }}
              </span>
            </div>
          </td>
          <td class="mono muted">
            <div v-for="repo in r.repos" :key="repo.path">{{ repo.url ?? repo.path }}</div>
          </td>
          <td class="muted mono">
            <div>{{ formatUsd(r.totalCostUsd) }}</div>
            <div style="font-size: 11px" :title="`in ${r.totalUsage?.inputTokens ?? 0} · out ${r.totalUsage?.outputTokens ?? 0} · cache read ${r.totalUsage?.cacheReadInputTokens ?? 0} · cache write ${r.totalUsage?.cacheCreationInputTokens ?? 0}`">
              {{ formatTokens(totalTokens(r.totalUsage)) }} tok
            </div>
          </td>
          <td class="muted">{{ new Date(r.updatedAt).toLocaleString() }}</td>
        </tr>
      </tbody>
    </table>

    <LaunchRunDialog v-if="showDialog" @close="showDialog = false" @launched="onLaunched" />
  </div>
</template>

<style scoped>
h2 { margin: 0; }
table.runs { width: 100%; border-collapse: collapse; margin-top: 16px; }
table.runs th, table.runs td { padding: 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
table.runs th { background: var(--panel); color: var(--muted); font-weight: 500; }
.error { color: var(--danger); }
.attention { margin-top: 12px; border-color: var(--warn); }
.attention-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; min-width: 0; }
.attention-row .reason { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
</style>
