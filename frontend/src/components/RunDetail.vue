<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { api } from "../api.js";
import { useRunSocket } from "../composables/useRunSocket.js";
import {
  addUsage,
  emptyUsage,
  formatTokens,
  formatUsd,
  ROLE_LABELS,
  ROLES,
  stateChipClass,
  totalTokens,
  type AttemptUsage,
  type RoleId,
  type RunDetail,
  type RunEvent,
} from "../types.js";
import UsagePanel from "./UsagePanel.vue";
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

// Live token totals for the attempt currently running in each role.
const liveUsage = ref<Partial<Record<RoleId, { usage: AttemptUsage; costUsd: number }>>>({});

const MAX_EVENTS = 5000;

/*
 * Stream history: live WebSocket events are buffered until the persisted log
 * (runs/<id>/events.jsonl) has loaded, then merged by `seq` so nothing is
 * shown twice or lost in between.
 */
let historyLoaded = false;
let lastSeq = 0;
const buffered: RunEvent[] = [];
const historyNote = ref<string | null>(null);

function pushEvent(ev: RunEvent) {
  if (ev.seq !== undefined) {
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
  }
  events.value.push(ev);
  if (events.value.length > MAX_EVENTS) events.value.splice(0, events.value.length - MAX_EVENTS);
}

function applyLive(ev: RunEvent) {
  if (ev.type === "run.removed") {
    void router.push(ev.archived ? "/analytics" : "/");
    return;
  }
  if (ev.type === "role.usage") {
    // Not added to the stream; the final numbers land in run.json on role.ended.
    liveUsage.value = { ...liveUsage.value, [ev.role]: { usage: ev.usage, costUsd: ev.costUsd } };
    return;
  }
  if (ev.type === "role.queued" || ev.type === "role.started") refresh();
  if (ev.type === "role.started" || ev.type === "role.ended") {
    const { [ev.role]: _drop, ...rest } = liveUsage.value;
    liveUsage.value = rest;
  }
  pushEvent(ev);
  if (
    ev.type === "run.transitioned" ||
    ev.type === "role.ended" ||
    ev.type === "approval.requested" ||
    ev.type === "approval.resolved" ||
    ev.type === "run.failed" ||
    ev.type === "run.overlaps"
  ) {
    refresh();
  }
}

useRunSocket(props.id, (ev) => {
  if (!historyLoaded) buffered.push(ev);
  else applyLive(ev);
});

onMounted(async () => {
  try {
    const { events: history } = await api.getEvents(props.id, MAX_EVENTS);
    for (const ev of history) if (ev.type !== "role.usage") pushEvent(ev);
    if (history.length >= MAX_EVENTS) historyNote.value = `Showing the last ${MAX_EVENTS} events.`;
  } catch {
    historyNote.value = "Could not load earlier events; showing live events only.";
  }
  historyLoaded = true;
  for (const ev of buffered.splice(0)) applyLive(ev);
});

// File overlaps with other active runs on the same repos.
const overlapBusy = ref(false);
async function recheckOverlaps() {
  overlapBusy.value = true;
  try {
    await api.refreshOverlaps(props.id);
    await refresh();
  } finally {
    overlapBusy.value = false;
  }
}

function roleChip(role: RoleId): { label: string; cls: string } {
  const attempts = detail.value?.roles?.[role] ?? [];
  const last = attempts[attempts.length - 1];
  if (!last) return { label: "idle", cls: "idle" };
  if (last.status === "running") return { label: "running", cls: "running" };
  if (last.status === "queued") return { label: "queued", cls: "awaiting" };
  if (last.status === "awaiting_approval") return { label: "awaiting approval", cls: "awaiting" };
  if (last.status === "done") return { label: "done", cls: "done" };
  if (last.status === "failed") return { label: "failed", cls: "failed" };
  if (last.status === "blocked") return { label: "blocked", cls: "warn" };
  if (last.status === "aborted") return { label: "aborted", cls: "paused" };
  return { label: last.status, cls: "idle" };
}

function roleCost(role: RoleId): number {
  const done = (detail.value?.roles?.[role] ?? []).reduce((sum, a) => sum + (a.costUsd ?? 0), 0);
  return done + (isRunning(role) ? liveUsage.value[role]?.costUsd ?? 0 : 0);
}

function isRunning(role: RoleId): boolean {
  const attempts = detail.value?.roles?.[role] ?? [];
  return attempts[attempts.length - 1]?.status === "running";
}

function roleTokens(role: RoleId): number {
  let u = emptyUsage();
  for (const a of detail.value?.roles?.[role] ?? []) u = addUsage(u, a.usage);
  if (isRunning(role)) u = addUsage(u, liveUsage.value[role]?.usage);
  return totalTokens(u);
}

const runTokens = computed(() => {
  let n = totalTokens(detail.value?.totalUsage);
  for (const r of ROLES) if (isRunning(r)) n += totalTokens(liveUsage.value[r]?.usage);
  return n;
});
const runCost = computed(() => {
  let c = detail.value?.totalCostUsd ?? 0;
  for (const r of ROLES) if (isRunning(r)) c += liveUsage.value[r]?.costUsd ?? 0;
  return c;
});

/** Unit Tester runs twice per cycle; show which phase its latest attempt was. */
function rolePhase(role: RoleId): string | null {
  if (role !== "unitTester") return null;
  const attempts = detail.value?.roles?.unitTester ?? [];
  const last = attempts[attempts.length - 1];
  if (last?.state === "unit_tests_red_running") return "red";
  if (last?.state === "unit_tests_green_running") return "green";
  return null;
}

const artifactsForRole = computed(() => {
  if (!detail.value) return [];
  return detail.value.artifacts.filter((a) => a.owner === activeRole.value);
});

const orchestratorArtifacts = computed(() => {
  if (!detail.value) return [];
  return detail.value.artifacts.filter((a) => a.owner === "orchestrator");
});

const stateCls = computed((): string => (detail.value ? stateChipClass(detail.value.state) : "idle"));

watch(artifactsForRole, (a) => {
  if (a.length > 0 && !a.find((x) => x.relative === activeArtifact.value)) {
    activeArtifact.value = a[0]?.relative ?? null;
  }
}, { immediate: true });

async function skip() { await api.skip(props.id); await refresh(); }
async function jump(to: RoleId) { await api.jump(props.id, to); activeRole.value = to; await refresh(); }
async function abort() { await api.abort(props.id); await refresh(); }

// Archive / delete: only for finished, failed, paused or unstarted runs.
const router = useRouter();
const canRemove = computed(() => ["done", "failed", "paused", "created"].includes(detail.value?.state ?? ""));
const removeErr = ref<string | null>(null);
async function removeRun(mode: "archive" | "delete") {
  removeErr.value = null;
  const what =
    mode === "archive"
      ? "Archive this run? Its worktrees and sessions are removed (branches stay); artifacts and history move to runs/.archive and still count in Analytics."
      : "Delete this run permanently? Its worktrees, artifacts, history and sessions are removed (branches stay).";
  if (!window.confirm(what)) return;
  const call = (force: boolean) => (mode === "archive" ? api.archiveRun(props.id, force) : api.deleteRun(props.id, force));
  try {
    await call(false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/uncommitted changes/.test(msg) || !window.confirm(`${msg}\n\nDiscard those changes and continue?`)) {
      removeErr.value = msg;
      return;
    }
    try {
      await call(true);
    } catch (e2) {
      removeErr.value = e2 instanceof Error ? e2.message : String(e2);
      return;
    }
  }
  await router.push(mode === "archive" ? "/analytics" : "/");
}

const hasWorktrees = computed(() => detail.value?.repos.some((r) => r.workPath) ?? false);
const canRemoveWorktrees = computed(() => hasWorktrees.value && ["done", "failed", "paused"].includes(detail.value?.state ?? ""));
const worktreeMsg = ref<string | null>(null);
async function removeWorktrees() {
  worktreeMsg.value = null;
  try {
    let { results } = await api.removeWorkspaces(props.id, false);
    const dirty = results.filter((r) => !r.removed);
    if (dirty.length > 0) {
      const detailText = dirty.map((r) => `${r.workPath}: ${r.error}`).join("\n");
      if (window.confirm(`Some worktrees could not be removed (uncommitted changes?):\n\n${detailText}\n\nDiscard those changes and remove anyway?`)) {
        ({ results } = await api.removeWorkspaces(props.id, true));
      }
    }
    const failed = results.filter((r) => !r.removed);
    worktreeMsg.value = failed.length ? `Not removed: ${failed.map((r) => r.workPath).join(", ")}` : "Worktrees removed. Branches are kept.";
  } catch (e) {
    worktreeMsg.value = e instanceof Error ? e.message : String(e);
  }
  await refresh();
}
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
        <span class="chip" title="Total SDK cost for this run">{{ formatUsd(runCost) }}</span>
        <span class="chip" title="Total tokens (input + output + cache read + cache write)">{{ formatTokens(runTokens) }} tokens</span>
        <span v-if="detail.fixIterations" class="chip" title="Fix loops so far">fix loops: {{ detail.fixIterations }}</span>
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
          {{ repo.path }} (<span v-if="repo.stacks?.length">{{ repo.stacks.join(" + ") }}, </span>base: {{ repo.baseBranch }}<span v-if="repo.branch">, branch: {{ repo.branch }}</span><span v-if="repo.aiGuidelinePath">, ai-guideline: {{ repo.aiGuidelinePath }}</span>)
          <div v-if="repo.workPath" style="font-size: 11px">↳ worktree: {{ repo.workPath }}</div>
        </div>
        <div v-if="detail.workspace === 'in-place'" style="font-size: 11px">This run predates per-run worktrees and works in the checkout directly.</div>
      </div>
      <div v-if="detail.state === 'failed' && detail.failureReason" class="error" style="margin-top: 8px; white-space: pre-wrap">Failure: {{ detail.failureReason }}</div>
      <div v-if="detail.ports" class="muted mono" style="font-size: 11px; margin-top: 2px">
        ports: {{ detail.ports.base }}–{{ detail.ports.base + detail.ports.count - 1 }}
      </div>
      <div v-if="detail.overlaps && detail.overlaps.length" class="overlap-note">
        <div class="row" style="gap: 8px">
          <strong>Overlaps with other active runs</strong>
          <div class="spacer" />
          <button @click="recheckOverlaps" :disabled="overlapBusy">{{ overlapBusy ? "Checking…" : "Re-check" }}</button>
        </div>
        <div v-for="o in detail.overlaps" :key="o.otherRunId + o.repoPath" style="margin-top: 4px">
          <RouterLink :to="`/runs/${o.otherRunId}`">{{ o.otherLabel }}</RouterLink>
          <span class="muted"> also changes in <span class="mono">{{ o.repoPath }}</span>:&nbsp;</span>
          <span class="mono">{{ o.files.join(", ") }}</span>
        </div>
        <div class="muted" style="font-size: 11px; margin-top: 4px">
          Whichever PR merges second will likely conflict. Consider finishing one run first; the orchestrator also syncs with the base before each PR.
        </div>
      </div>
      <div v-if="worktreeMsg" class="muted" style="margin-top: 8px; font-size: 12px">{{ worktreeMsg }}</div>
      <div v-if="detail.state === 'paused' && detail.pauseReason" class="paused-note">
        Paused: {{ detail.pauseReason }}
      </div>
      <div class="row" style="margin-top: 12px; gap: 6px; flex-wrap: wrap">
        <button v-for="r in ROLES" :key="r" @click="jump(r)">Jump → {{ ROLE_LABELS[r] }}</button>
        <div class="spacer" />
        <button v-if="hasWorktrees" @click="removeWorktrees" :disabled="!canRemoveWorktrees" title="Available when the run is done, failed or paused. Branches are kept.">Remove worktrees</button>
        <button class="warn" @click="skip" :disabled="!detail.pendingApproval">Skip gate</button>
        <button class="danger" @click="abort" :disabled="detail.state === 'done' || detail.state === 'paused' || detail.state === 'failed'">Abort</button>
      </div>
      <div class="row" style="margin-top: 6px; gap: 6px; flex-wrap: wrap">
        <span class="muted" style="font-size: 12px">Usage export:</span>
        <a :href="api.exportUrl(detail.runId, 'csv')" download>CSV</a>
        <a :href="api.exportUrl(detail.runId, 'json')" download>JSON</a>
        <div class="spacer" />
        <button @click="removeRun('archive')" :disabled="!canRemove" title="Done, failed, paused or unstarted runs only">Archive</button>
        <button class="danger" @click="removeRun('delete')" :disabled="!canRemove" title="Done, failed, paused or unstarted runs only">Delete</button>
      </div>
      <div v-if="removeErr" class="error" style="margin-top: 6px; white-space: pre-wrap">{{ removeErr }}</div>

    </div>

    <div class="roles">
      <button
        v-for="r in ROLES"
        :key="r"
        class="role-tab"
        :class="{ active: activeRole === r }"
        @click="activeRole = r"
      >
        <span>{{ ROLE_LABELS[r] }}</span>
        <span class="chip" :class="roleChip(r).cls">{{ roleChip(r).label }}<template v-if="rolePhase(r)"> · {{ rolePhase(r) }}</template></span>
        <span v-if="roleTokens(r) > 0" class="muted mono" style="font-size: 11px" title="tokens · cost">
          {{ formatTokens(roleTokens(r)) }} · {{ formatUsd(roleCost(r)) }}
        </span>
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
        <p v-if="historyNote" class="muted" style="font-size: 11px; margin: 0 0 4px">{{ historyNote }}</p>
        <h3>
          {{ ROLE_LABELS[activeRole] }} — stream
          <span class="muted mono" style="font-size: 11px; font-weight: normal">model: {{ detail.effectiveModels[activeRole] }}</span>
        </h3>
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

    <UsagePanel :detail="detail" :live="liveUsage" />
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
.overlap-note { margin-top: 8px; padding: 8px 12px; border: 1px solid var(--warn); border-radius: 4px; font-size: 13px; }
.paused-note { margin-top: 8px; padding: 8px 12px; border: 1px dashed var(--warn); border-radius: 4px; color: var(--warn); }
.manual-source ul { margin-top: 6px; }
</style>
