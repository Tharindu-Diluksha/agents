<script setup lang="ts">
import { computed, ref } from "vue";
import { api } from "../api.js";
import { STATE_LABELS, type ContextDraft, type RunDetail } from "../types.js";
import { emptyDraft, hasContent, releaseDraft, toContextUpload } from "../composables/contextDraft.js";
import ContextEditor from "./ContextEditor.vue";

/** The run's extra notes / mockups: what's there, and a form to add more. */
const props = defineProps<{ detail: RunDetail }>();
const emit = defineEmits<{ (e: "added"): void }>();

const items = computed(() => props.detail.attachments ?? []);
const notes = computed(() => items.value.filter((a) => a.kind === "note"));
const images = computed(() => items.value.filter((a) => a.kind === "image"));
const canAdd = computed(() => props.detail.state !== "done");
const atDocGate = computed(() => props.detail.state === "awaiting_feature_doc_approval");

const open = ref(false);
const draft = ref<ContextDraft>(emptyDraft());
const busy = ref(false);
const err = ref<string | null>(null);

function stageLabel(stage: string): string {
  return stage === "created" ? "at launch" : `during: ${STATE_LABELS[stage as keyof typeof STATE_LABELS] ?? stage}`;
}

async function add() {
  err.value = null;
  busy.value = true;
  try {
    await api.addAttachments(props.detail.runId, await toContextUpload(draft.value));
    releaseDraft(draft.value);
    open.value = false;
    emit("added");
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel ctx-panel">
    <div class="row" style="align-items: center">
      <h3 style="margin: 0">Context and mockups</h3>
      <span class="muted" style="font-size: 12px; margin-left: 8px">{{ notes.length }} note(s) · {{ images.length }} image(s) · every agent gets these</span>
      <div class="spacer" />
      <button v-if="canAdd && !open" @click="open = true">+ Add</button>
    </div>

    <div v-if="items.length === 0 && !open" class="muted" style="font-size: 12px; margin-top: 6px">
      Nothing added yet. Add notes or mockups that aren't in the ticket; the agents read them from their next run.
    </div>

    <div v-for="n in notes" :key="n.id" class="note">
      <div class="muted" style="font-size: 11px">Note · {{ stageLabel(n.stage) }}</div>
      <div class="note-text">{{ n.text }}</div>
    </div>

    <div v-if="images.length" class="imgs">
      <a v-for="i in images" :key="i.id" :href="api.attachmentUrl(detail.runId, i.file!)" target="_blank" rel="noopener" class="img" :title="i.originalName">
        <img :src="api.attachmentUrl(detail.runId, i.file!)" :alt="i.text ?? i.originalName ?? 'image'" loading="lazy" />
        <span class="cap">{{ i.text || i.originalName }}</span>
        <span class="muted" style="font-size: 10px">{{ stageLabel(i.stage) }}</span>
      </a>
    </div>

    <div v-if="open" class="add">
      <ContextEditor v-model="draft" />
      <div class="muted" style="font-size: 11px; margin-top: 6px">
        <template v-if="atDocGate">
          To have the Analyst use them in the feature doc, add them and then <strong>reject</strong> the feature doc above (say what to update). Approving keeps the doc as is, and the next agents still get them.
        </template>
        <template v-else>A running agent won't see them until its next run; every agent that starts after this does.</template>
      </div>
      <div class="row" style="gap: 6px; margin-top: 6px">
        <div class="spacer" />
        <button :disabled="busy" @click="open = false">Cancel</button>
        <button class="primary" :disabled="busy || !hasContent(draft)" @click="add">{{ busy ? "Uploading…" : "Add to run" }}</button>
      </div>
      <div v-if="err" class="error" style="font-size: 12px; margin-top: 4px">{{ err }}</div>
    </div>
  </section>
</template>

<style scoped>
.ctx-panel { display: flex; flex-direction: column; gap: 8px; }
.note { border-left: 3px solid var(--border); padding: 2px 8px; }
.note-text { white-space: pre-wrap; font-size: 13px; }
.imgs { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.img { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border); border-radius: 6px; padding: 6px; text-decoration: none; color: var(--text); min-width: 0; }
.img img { width: 100%; height: 100px; object-fit: contain; background: var(--panel2); border-radius: 4px; }
.cap { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.add { border-top: 1px solid var(--border); padding-top: 8px; }
.error { color: var(--danger); }
</style>
