<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="shell">
    <header>
      <RouterLink to="/" class="brand">Agent Orchestrator</RouterLink>
      <span class="muted">multi-agent workflow</span>
    </header>
    <main>
      <RouterView />
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
