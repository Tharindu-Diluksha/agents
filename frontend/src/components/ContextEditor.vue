<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { ContextDraft } from "../types.js";
import { addFiles, IMAGE_TYPES, releaseDraft, removeImage } from "../composables/contextDraft.js";

/*
 * Extra notes + images (mockups, screenshots) for a run. Images can be
 * picked, dropped, or pasted into the note box. The parent uploads the draft
 * (see toContextUpload) and owns when it's sent.
 */
const draft = defineModel<ContextDraft>({ required: true });
defineProps<{ placeholder?: string }>();

const picker = ref<HTMLInputElement | null>(null);
const refused = ref<string | null>(null);
const dragging = ref(false);

function take(files: FileList | File[] | null | undefined) {
  if (!files) return;
  refused.value = addFiles(draft.value, Array.from(files));
}
function onPick(e: Event) {
  const input = e.target as HTMLInputElement;
  take(input.files);
  input.value = ""; // allow picking the same file again
}
function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
  if (files.length === 0) return; // plain text paste
  e.preventDefault();
  take(files);
}
function onDrop(e: DragEvent) {
  dragging.value = false;
  take(e.dataTransfer?.files);
}

onBeforeUnmount(() => releaseDraft(draft.value));
</script>

<template>
  <div class="ctx" :class="{ dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
    <textarea
      v-model="draft.note"
      :placeholder="placeholder ?? 'Extra requirements, constraints, links… (paste or drop images here)'"
      @paste="onPaste"
    ></textarea>
    <div class="row" style="gap: 8px; align-items: center; margin-top: 6px">
      <button type="button" @click="picker?.click()">+ Add images</button>
      <span class="muted" style="font-size: 11px">PNG, JPEG, GIF or WebP · up to 5 MB each · or paste / drop them</span>
      <input ref="picker" type="file" multiple :accept="IMAGE_TYPES.join(',')" style="display: none" @change="onPick" />
    </div>
    <div v-if="refused" class="refused">{{ refused }}</div>
    <div v-if="draft.images.length" class="thumbs">
      <div v-for="(img, i) in draft.images" :key="img.url" class="thumb">
        <img :src="img.url" :alt="img.file.name" />
        <input v-model="img.caption" placeholder="caption (optional)" />
        <div class="row" style="gap: 4px; align-items: center">
          <span class="muted mono name" :title="img.file.name">{{ img.file.name || "pasted image" }}</span>
          <button type="button" class="danger" title="Remove" @click="removeImage(draft, i)">✕</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx { border: 1px dashed transparent; border-radius: 6px; }
.ctx.dragging { border-color: var(--accent); }
textarea { width: 100%; min-height: 70px; }
.refused { color: var(--warn); font-size: 12px; margin-top: 4px; }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 8px; }
.thumb { border: 1px solid var(--border); border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.thumb img { width: 100%; height: 90px; object-fit: contain; background: var(--panel); border-radius: 4px; }
.thumb input { font-size: 11px; }
.thumb .name { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
.thumb button { padding: 0 6px; font-size: 11px; }
</style>
