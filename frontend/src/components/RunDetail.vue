<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";
import { useRunSocket } from "../composables/useRunSocket.js";
import { ROLES, type RoleId, type RunDetail, type RunEvent, type RunState } from "../types.js";
import RoleStream from "./RoleStream.vue";
import ArtifactPreview from "./ArtifactPreview.vue";
import ApprovalCard from "./ApprovalCard.vue";

const props = defineProps<{ id: string }>();

const detail = ref<RunDetail | null>(null);
const err = ref<string | null>(null);
const events = ref<RunEvent[]>([]);
const activeRole = ref<RoleId>("analyst");
const activeArtifact = ref<string | null>(null);

async function refresh() {
  try {
    detail.value = await api.getRun(props.id);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(refresh);

useRunSocket(props.id, (ev) => {
  events.value.push(ev);
  if (events.value.length > 2000) events.value.splice(0, events.value.length - 2000);
  if (ev.type === "run.transitioned" || ev.type === "role.ended" || ev.type === "approval.requested" || ev.type === "approval.resolved" || ev.type === "run.failed") {
    refresh();
  }
});

function roleChip(role: RoleId): { label: string; cls: string } {
  const attempts = detail.value?.roles?.[role] ?? [];
  const last = attempts[attempts.length - 1];
  if (!last) return { label: "idle", cls: "idle" };
  if (last.status === "running") return { label: "running", cls: "running" };
  if (last.status === "awaiting_approval") return { label: "awaiting approval", cls: "awaiting" };
  if (last.status === "done") return { label: "done", cls: "done" };
  if (last.status === "failed") return { label: "failed", cls: "failed" };
  if (last.status === "blocked") return { label: "blocked", cls: "warn" };
  return { label: last.status, cls: "idle" };
}

const artifactsForRole = computed(() => {
  if (!detail.value) return [];
  return detail.value.artifacts.filter((a) => a.owner === activeRole.value);
});

const orchestratorArtifacts = computed(() => {
  if (!detail.value) return [];
  return detail.value.artifacts.filter((a) => a.owner === "orchestrator");
});

const stateCls = computed((): string => {
  const s = detail.value?.state;
  if (!s) return "idle";
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s.startsWith("awaiting_")) return "awaiting";
  return "running";
});

watch(artifactsForRole, (a) => {
  if (a.length > 0 && !a.find((x) => x.relative === activeArtifact.value)) {
    activeArtifact.value = a[0]?.relative ?? null;
  }
}, { immediate: true });

async function skip() { await api.skip(props.id); await refresh(); }
async function jump(to: RoleId) { await api.jump(props.id, to); activeRole.value = to; await refresh(); }
async function abort() { await api.abort(props.id); await refresh(); }
</script>

<template>
  <div v-if="err" class="error">{{ err }}</div>
  <div v-else-if="!detail" class="muted">Loading…</div>
  <div v-else class="layout">
    <div class="header panel">
      <div class="row">
        <h2 style="margin:0">{{ detail.label }}</h2>
        <span class="chip" :class="stateCls">{{ detail.state }}</span>
        <span v-if="detail.source.kind === 'manual'" class="chip">{{ detail.source.type }}</span>
        <div class="spacer" />
        <a v-if="detail.source.kind === 'jira'" :href="detail.source.ticketUrl" target="_blank" rel="noreferrer">Open JIRA ticket ↗</a>
      </div>
      <div v-if="detail.source.kind === 'manual'" class="manual-source">
        <strong>{{ detail.source.title }}</strong>
        <p class="muted" style="white-space: pre-wrap">{{ detail.source.description }}</p>
        <div v-if="detail.source.acceptanceCriteria.length" class="muted" style="font-size: 12px">
          <div style="margin-bottom: 2px">Acceptance criteria:</div>
          <ul style="margin: 0; padding-left: 18px">
            <li v-for="(c, i) in detail.source.acceptanceCriteria" :key="i">{{ c }}</li>
          </ul>
        </div>
      </div>
      <div class="muted mono" style="margin-top: 4px">
        <div v-for="repo in detail.repos" :key="repo.path">
          {{ repo.path }} (base: {{ repo.baseBranch }}<span v-if="repo.aiGuidelinePath">, ai-guideline: {{ repo.aiGuidelinePath }}</span>)
        </div>
      </div>
      <div v-if="detail.failureReason" class="error" style="margin-top: 8px">Failure: {{ detail.failureReason }}</div>
      <div class="row" style="margin-top: 12px; gap: 6px; flex-wrap: wrap">
        <button v-for="r in ROLES" :key="r" @click="jump(r)">Jump → {{ r }}</button>
        <div class="spacer" />
        <button class="warn" @click="skip" :disabled="!detail.pendingApproval">Skip gate</button>
        <button class="danger" @click="abort">Abort</button>
      </div>
    </div>

    <div class="roles">
      <button
        v-for="r in ROLES"
        :key="r"
        class="role-tab"
        :class="{ active: activeRole === r }"
        @click="activeRole = r"
      >
        <span>{{ r }}</span>
        <span class="chip" :class="roleChip(r).cls">{{ roleChip(r).label }}</span>
      </button>
    </div>

    <ApprovalCard
      v-if="detail.pendingApproval"
      :run-id="detail.runId"
      :pending="detail.pendingApproval"
      @resolved="refresh"
    />

    <div class="main">
      <section class="panel stream-panel">
        <h3>{{ activeRole }} — stream</h3>
        <RoleStream :role="activeRole" :events="events" />
      </section>

      <section class="panel art-panel">
        <h3>Artifacts</h3>
        <div v-if="artifactsForRole.length === 0 && orchestratorArtifacts.length === 0" class="muted">No artifacts yet.</div>
        <div v-else>
          <div class="row" style="gap:6px; flex-wrap: wrap; margin-bottom: 8px">
            <button
              v-for="a in artifactsForRole"
              :key="a.relative"
              @click="activeArtifact = a.relative"
              :class="{ primary: activeArtifact === a.relative }"
            >
              {{ a.name }}
            </button>
            <button
              v-for="a in orchestratorArtifacts"
              :key="a.relative"
              @click="activeArtifact = a.relative"
              :class="{ primary: activeArtifact === a.relative }"
              title="Orchestrator-generated artifact"
            >
              {{ a.name }} <span class="muted" style="font-size: 10px">· orchestrator</span>
            </button>
          </div>
          <ArtifactPreview v-if="activeArtifact" :run-id="detail.runId" :relative="activeArtifact" />
          <p class="muted" style="font-size: 11px; margin-top: 8px">
            All artifacts for this run live in <span class="mono">runs/{{ detail.runId }}/</span>
          </p>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.layout { display: flex; flex-direction: column; gap: 16px; }
.header h2 { font-size: 16px; }
.roles { display: flex; gap: 6px; flex-wrap: wrap; }
.role-tab { display: flex; align-items: center; gap: 8px; }
.role-tab.active { background: var(--panel2); border-color: var(--accent); }
.main { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
@media (max-width: 1100px) { .main { grid-template-columns: 1fr; } }
.stream-panel h3, .art-panel h3 { margin: 0 0 8px; }
.error { color: var(--danger); }
.manual-source { background: var(--panel2); border-left: 3px solid var(--accent); padding: 8px 12px; border-radius: 4px; margin-top: 8px; }
.manual-source p { margin: 4px 0; }
.manual-source ul { margin-top: 6px; }
</style>
