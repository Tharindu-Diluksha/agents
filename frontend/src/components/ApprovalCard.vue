<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api.js";
import type { PendingApproval, ProposedBranches } from "../types.js";
import { countOpenQuestions } from "../openQuestions.js";

const props = defineProps<{ runId: string; pending: PendingApproval }>();
const emit = defineEmits<{ (e: "resolved"): void }>();

const feedback = ref("");
const activePayload = ref<string | null>(props.pending.payloadPaths[0] ?? null);
const payloadBody = ref<string | null>(null);
const edited = ref<string | null>(null);
const branches = ref<ProposedBranches | null>(null);
const busy = ref(false);
const err = ref<string | null>(null);

const isBranchApproval = computed(() => props.pending.action === "approve_branch_names");
/** The Analyst's feature-doc gate: the place to answer its open questions. */
const isFeatureDocGate = computed(() => props.pending.action === "proceed_to_next" && props.pending.role === "analyst");
/** The code-review gate: reject sends the work to the Developer (not back to the Reviewer). */
const isReviewGate = computed(() => props.pending.action === "proceed_to_next" && props.pending.role === "reviewer");
/** Gates whose reject re-runs the role with the typed text. Elsewhere the text would never be delivered. */
const feedbackReachesRole = computed(() => props.pending.action === "proceed_to_next" || props.pending.action === "create_pr");
/** Approving never carries the text, so don't let it be dropped silently. */
const hasFeedback = computed(() => feedback.value.trim().length > 0);
const openQuestions = ref(0);
/** Why Approve is disabled, or null when it isn't. */
const approveBlockedReason = computed<string | null>(() => {
  if (feedbackReachesRole.value && hasFeedback.value) {
    return `Approve is disabled while this box has text — approving would discard it. Send it with “${rejectLabel()}”, or clear the box to approve.`;
  }
  if (isFeatureDocGate.value && openQuestions.value > 0) {
    return `Approve is disabled while the feature doc has ${openQuestions.value} open question${openQuestions.value === 1 ? "" : "s"}. Answer them above and click “Send answers + revise”.`;
  }
  return null;
});
const approveBlocked = computed(() => approveBlockedReason.value !== null);

async function loadOpenQuestions() {
  openQuestions.value = 0;
  if (!isFeatureDocGate.value) return;
  try {
    openQuestions.value = countOpenQuestions(await api.getArtifact(props.runId, "analyst/feature-doc.md"));
  } catch {
    // No feature doc yet — show no count.
  }
}
watch(() => props.pending.requestedAt, loadOpenQuestions, { immediate: true });

async function loadActive() {
  const rel = activePayload.value;
  if (!rel) return;
  err.value = null;
  edited.value = null;
  branches.value = null;
  try {
    const body = await api.getArtifact(props.runId, rel);
    payloadBody.value = body;
    if (isBranchApproval.value) {
      try {
        branches.value = JSON.parse(body) as ProposedBranches;
      } catch {
        err.value = "proposed-branches.json is not valid JSON";
      }
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
    payloadBody.value = null;
  }
}

watch(activePayload, loadActive, { immediate: true });
watch(
  () => props.pending.payloadPaths.join("|"),
  (joined) => {
    activePayload.value = joined ? joined.split("|")[0] ?? null : null;
  },
);

function approveLabel() {
  const n = props.pending.payloadPaths.length;
  switch (props.pending.action) {
    case "post_jira_comment": return "Approve + post JIRA comment";
    case "create_test_suite": return "Approve suite creation";
    case "create_pr": return n > 1 ? `Approve + create ${n} PRs` : "Approve + create PR";
    case "approve_branch_names":
      return `Approve + create ${branches.value?.perRepo.length ?? 0} branch(es)`;
    default: return isReviewGate.value ? "Approve + continue to E2E" : "Approve";
  }
}

function rejectLabel() {
  if (isBranchApproval.value) return "Cancel run";
  if (props.pending.action === "create_test_suite") return "Decline + skip E2E";
  if (isFeatureDocGate.value && hasFeedback.value) return "Send answers + revise";
  if (isReviewGate.value) return "Send to Developer to fix";
  return "Reject + re-run";
}

async function act(decision: "approve" | "reject" | "edit" | "skip") {
  busy.value = true;
  err.value = null;
  try {
    let sendEdited: string | undefined;
    if (isBranchApproval.value && (decision === "approve" || decision === "edit") && branches.value) {
      sendEdited = JSON.stringify(branches.value);
    } else if (decision === "edit" && edited.value !== null) {
      sendEdited = edited.value;
    }
    await api.approve(props.runId, {
      decision,
      feedback: feedback.value.trim() || undefined,
      editedPayload: sendEdited,
    });
    emit("resolved");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

const canEditMarkdown = () => !isBranchApproval.value && props.pending.payloadPaths.length === 1;
</script>

<template>
  <div class="panel approval">
    <div class="row">
      <strong>Awaiting approval</strong>
      <span class="chip awaiting">{{ pending.action }}</span>
      <span v-if="openQuestions > 0" class="chip awaiting" title="Items under ## Open questions in feature-doc.md">
        {{ openQuestions }} open question{{ openQuestions === 1 ? "" : "s" }}
      </span>
      <div class="spacer" />
      <span class="muted">{{ new Date(pending.requestedAt).toLocaleTimeString() }}</span>
    </div>
    <p style="white-space: pre-wrap">{{ pending.summary }}</p>

    <!-- Branch names: per-repo editable rows -->
    <div v-if="isBranchApproval">
      <div v-if="branches">
        <div v-for="(r, i) in branches.perRepo" :key="r.repoPath" class="branch-row">
          <div class="mono muted">{{ r.repoPath }}</div>
          <div class="row" style="gap: 8px; align-items: center; margin-top: 4px">
            <span class="muted" style="font-size: 12px">base: {{ r.baseBranch }}</span>
            <span v-if="r.currentBranch" class="muted" style="font-size: 12px">· current: {{ r.currentBranch }}</span>
          </div>
          <label>New branch</label>
          <input v-model="branches.perRepo[i]!.suggestedBranch" placeholder="feature/..." />
          <p v-if="r.note" class="muted" style="font-size: 12px; margin: 4px 0 0">{{ r.note }}</p>
        </div>
        <p class="muted" style="margin-top: 8px">
          The orchestrator switches this run's own worktree of each repo to the branch (your checkout is not touched) before the Unit Tester writes the first failing tests.
        </p>
      </div>
      <p v-else-if="err" class="error">{{ err }}</p>
      <p v-else class="muted">Loading proposed branches…</p>
    </div>

    <!-- Default: markdown payload previews -->
    <div v-else-if="pending.payloadPaths.length > 0">
      <div v-if="pending.payloadPaths.length > 1" class="row" style="gap:6px; flex-wrap: wrap; margin-bottom: 8px">
        <button
          v-for="(p, i) in pending.payloadPaths"
          :key="p"
          @click="activePayload = p"
          :class="{ primary: activePayload === p }"
        >
          {{ p.split('/').pop() ?? `#${i + 1}` }}
        </button>
      </div>
      <p class="muted">Payload: <span class="mono">{{ activePayload }}</span></p>
      <pre v-if="edited === null && payloadBody !== null" class="mono preview-pre"><code>{{ payloadBody }}</code></pre>
      <textarea v-else-if="edited !== null" v-model="edited"></textarea>
      <div v-if="canEditMarkdown() && edited === null" style="margin-top:4px">
        <button @click="edited = payloadBody ?? ''">Edit this payload</button>
      </div>
      <p v-if="!canEditMarkdown() && pending.payloadPaths.length > 1" class="muted" style="margin-top:4px">
        Multi-payload approvals can't be inline-edited for now. Reject to re-run with feedback, or Abort and jump back to the role.
      </p>
    </div>

    <template v-if="feedbackReachesRole">
      <template v-if="isFeatureDocGate">
        <label class="muted" style="margin-top: 8px; display:block">Answers / feedback for the Analyst</label>
        <textarea
          v-model="feedback"
          :disabled="busy"
          :placeholder="openQuestions > 0
            ? 'Answer the open questions (e.g. 1. … 2. …) or describe what to change. The Analyst revises feature-doc.md and asks again.'
            : 'Describe what to change. The Analyst revises feature-doc.md and asks again.'"
        ></textarea>
      </template>
      <template v-else-if="isReviewGate">
        <label class="muted" style="margin-top: 8px; display:block">Notes for the Developer</label>
        <textarea
          v-model="feedback"
          :disabled="busy"
          placeholder="Optional. Which findings to fix or ignore, and how (e.g. “Fix 1–4, ignore the NITs”). The Developer gets the full review report plus these notes; the tests and review then run again."
        ></textarea>
      </template>
      <template v-else>
        <label class="muted" style="margin-top: 8px; display:block">Feedback for the {{ pending.role }} (sent with {{ rejectLabel() }})</label>
        <textarea v-model="feedback" :disabled="busy" placeholder="Optional feedback for a re-run..."></textarea>
      </template>
      <p v-if="approveBlockedReason" class="muted hint">{{ approveBlockedReason }}</p>
    </template>

    <p v-if="err" class="error">{{ err }}</p>

    <div class="row" style="margin-top: 12px">
      <button class="danger" @click="act('reject')" :disabled="busy">{{ rejectLabel() }}</button>
      <!-- On re-run gates the backend treats skip as reject, so Skip would just re-run the role. -->
      <button v-if="!isBranchApproval && !feedbackReachesRole" @click="act('skip')" :disabled="busy">Skip</button>
      <div class="spacer" />
      <button v-if="canEditMarkdown() && edited !== null" @click="act('edit')" :disabled="busy || approveBlocked">Approve edited</button>
      <button
        class="primary"
        @click="act('approve')"
        :disabled="busy || approveBlocked"
        :title="approveBlockedReason ?? ''"
      >{{ approveLabel() }}</button>
    </div>
  </div>
</template>

<style scoped>
.approval { border-color: var(--warn); }
.error { color: var(--danger); }
textarea { margin-top: 4px; }
.hint { font-size: 12px; margin: 4px 0 0; color: var(--warn); }
.preview-pre { max-height: 40vh; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; background: var(--panel2); padding: 10px; border-radius: 4px; }
.branch-row { border: 1px solid var(--border); border-radius: 6px; padding: 10px; margin-top: 8px; background: var(--panel2); }
.branch-row label { font-size: 12px; color: var(--muted); margin-top: 6px; display: block; }
</style>
