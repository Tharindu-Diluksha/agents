<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import type { AuditEntry } from "../types.js";

const entries = ref<AuditEntry[]>([]);
const enabled = ref(true);
const err = ref<string | null>(null);
const runId = ref("");
const action = ref("");
const more = ref(false);

async function load(append = false) {
  err.value = null;
  try {
    const before = append ? entries.value.at(-1)?.id : undefined;
    const res = await api.getAudit({ before, runId: runId.value.trim() || undefined, action: action.value || undefined });
    enabled.value = res.enabled;
    entries.value = append ? [...entries.value, ...res.entries] : res.entries;
    more.value = res.entries.length >= 100;
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}
onMounted(() => load());

const ACTIONS = ["", "login", "logout", "login_failed", "session_ended", "access_denied", "launch", "approve", "reject", "edit", "skip", "jump", "abort", "remove_worktrees", "archive", "delete"];
</script>

<template>
  <div class="page">
    <div class="row">
      <h2 style="margin: 0">Audit log</h2>
      <div class="spacer" />
      <input v-model="runId" placeholder="Run id" style="width: 220px" @keyup.enter="load()" />
      <select v-model="action" style="width: 170px" @change="load()">
        <option v-for="a in ACTIONS" :key="a" :value="a">{{ a || "all actions" }}</option>
      </select>
      <button @click="load()">Filter</button>
    </div>
    <p class="muted" style="margin: 0; font-size: 13px">Sign-ins, denied requests and every action on a run, newest first. Kept in Postgres, including actions on runs that were later deleted.</p>
    <p v-if="err" class="error">{{ err }}</p>
    <p v-else-if="!enabled" class="panel muted">No audit log: set DATABASE_URL to record one.</p>
    <section v-else class="panel table-wrap">
      <table>
        <thead><tr><th>When</th><th>User</th><th>Action</th><th>Run</th><th>Outcome</th><th>Details</th><th>IP</th></tr></thead>
        <tbody>
          <tr v-for="e in entries" :key="e.id">
            <td class="mono small">{{ new Date(e.at).toLocaleString() }}</td>
            <td>{{ e.userName ?? "—" }}</td>
            <td class="mono">{{ e.action }}</td>
            <td class="mono small"><RouterLink v-if="e.runId" :to="`/runs/${e.runId}`">{{ e.runId }}</RouterLink></td>
            <td><span class="chip" :class="e.outcome === 'ok' ? 'done' : e.outcome === 'denied' ? 'awaiting' : 'failed'">{{ e.outcome }}</span></td>
            <td class="mono small details">{{ Object.keys(e.details).length ? JSON.stringify(e.details) : "" }}</td>
            <td class="mono small muted">{{ e.ip }}</td>
          </tr>
        </tbody>
      </table>
      <button v-if="more" style="margin-top: 8px" @click="load(true)">Load older</button>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 12px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
th { color: var(--muted); font-weight: 500; }
.small { font-size: 11px; }
.details { max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
.error { color: var(--danger); }
</style>
