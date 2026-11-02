<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useRunsStore } from "../stores/runs.js";
import LaunchRunDialog from "./LaunchRunDialog.vue";
import { formatTokens, formatUsd, stateChipClass, totalTokens } from "../types.js";

const store = useRunsStore();
const router = useRouter();
const showDialog = ref(false);

onMounted(() => store.refresh());

function onLaunched(runId: string) {
  showDialog.value = false;
  router.push(`/runs/${runId}`);
}
</script>

<template>
  <div>
    <div class="row">
      <h2>Runs</h2>
      <div class="spacer" />
      <button class="primary" @click="showDialog = true">Launch new run</button>
      <button @click="store.refresh()" :disabled="store.loading">Refresh</button>
    </div>

    <p v-if="store.error" class="error">{{ store.error }}</p>

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
          </td>
          <td><span class="chip" :class="stateChipClass(r.state)">{{ r.state }}</span></td>
          <td class="mono muted">
            <div v-for="repo in r.repos" :key="repo.path">{{ repo.path }}</div>
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
</style>
