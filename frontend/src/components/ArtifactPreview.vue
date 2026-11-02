<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "../api.js";

const props = defineProps<{ runId: string; relative: string }>();
const body = ref<string>("");
const err = ref<string | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  err.value = null;
  try {
    body.value = await api.getArtifact(props.runId, props.relative);
  } catch (e) {
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

watch(() => props.relative, load, { immediate: true });
</script>

<template>
  <div class="panel preview">
    <div class="row">
      <strong class="mono">{{ relative }}</strong>
      <div class="spacer" />
      <button @click="load" :disabled="loading">Reload</button>
    </div>
    <p v-if="err" class="error">{{ err }}</p>
    <pre class="mono"><code>{{ body }}</code></pre>
  </div>
</template>

<style scoped>
.preview { display: flex; flex-direction: column; gap: 8px; }
pre { max-height: 60vh; overflow: auto; margin: 0; white-space: pre-wrap; word-break: break-word; }
.error { color: var(--danger); }
</style>
