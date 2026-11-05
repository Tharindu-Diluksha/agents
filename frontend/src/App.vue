<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
import { useAttention } from "./composables/useAttention.js";

const { attention, notifyPermission, enableNotifications } = useAttention();
</script>

<template>
  <div class="shell">
    <header>
      <RouterLink to="/" class="brand">Agent Orchestrator</RouterLink>
      <span class="muted">multi-agent workflow</span>
      <RouterLink to="/">Runs</RouterLink>
      <RouterLink to="/analytics">Analytics</RouterLink>
      <div style="flex: 1" />
      <RouterLink v-if="attention.length" to="/" class="chip awaiting" title="Runs waiting for you">
        {{ attention.length }} need{{ attention.length === 1 ? "s" : "" }} attention
      </RouterLink>
      <button v-if="notifyPermission === 'default'" @click="enableNotifications" title="Get a desktop notification when a run needs you">
        Enable notifications
      </button>
    </header>
    <main>
      <!-- Keyed so switching between runs remounts the page (fresh socket + history). -->
      <RouterView :key="$route.fullPath" />
    </main>
  </div>
</template>

<style scoped>
.shell { max-width: 1400px; margin: 0 auto; padding: 16px; }
header {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 8px 0 16px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.brand { font-weight: 600; font-size: 16px; color: var(--text); }
.brand:hover { text-decoration: none; color: var(--accent); }
</style>
