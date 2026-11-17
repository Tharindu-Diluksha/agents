<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { EFFORT_LEVELS, type EffortLevel, type RoleId, type ServerConfig } from "../types.js";

/*
 * Model + reasoning-effort selects for one role, shared by the launch dialog
 * and the run page. "" means "server default" for both (CLAUDE_MODEL[_<ROLE>],
 * CLAUDE_EFFORT[_<ROLE>]); "Custom…" accepts any model id.
 */
const props = defineProps<{ role: RoleId; config: ServerConfig | null; disabled?: boolean }>();
const model = defineModel<string>("model", { required: true });
const effort = defineModel<EffortLevel | "">("effort", { required: true });

const CUSTOM = "__custom__";
const options = computed(() => props.config?.modelOptions ?? []);
const effortLevels = computed<readonly EffortLevel[]>(() => props.config?.effortLevels ?? EFFORT_LEVELS);

// A model that isn't in the list shows in the custom box. Re-checked when the list arrives.
const isListed = (m: string) => m === "" || options.value.includes(m);
const custom = ref(!isListed(model.value));
watch(options, () => {
  if (isListed(model.value)) custom.value = false;
});

const choice = computed({
  get: () => (custom.value ? CUSTOM : model.value),
  set: (v: string) => {
    custom.value = v === CUSTOM;
    if (v !== CUSTOM) model.value = v;
  },
});
</script>

<template>
  <div class="picker">
    <div class="pick-row">
      <select v-model="choice" :disabled="disabled" class="mono" title="Model">
        <option value="">Default ({{ config?.models[role] ?? "server" }})</option>
        <option v-for="m in options" :key="m" :value="m">{{ m }}</option>
        <option :value="CUSTOM">Custom…</option>
      </select>
      <select v-model="effort" :disabled="disabled" class="effort" title="Reasoning effort">
        <option value="">Effort: {{ config?.efforts[role] ?? "model default" }}</option>
        <option v-for="e in effortLevels" :key="e" :value="e">Effort: {{ e }}</option>
      </select>
    </div>
    <input
      v-if="custom"
      v-model.trim="model"
      :disabled="disabled"
      placeholder="model id, e.g. claude-opus-5-5 (blank = default)"
      class="mono"
    />
  </div>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.pick-row { display: flex; gap: 6px; }
.pick-row select { flex: 1 1 0; min-width: 0; }
.pick-row select.effort { flex: 0 0 150px; }
</style>
