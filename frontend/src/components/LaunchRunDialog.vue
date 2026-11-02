<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "../api.js";
import { ROLE_LABELS, ROLES, type JiraMcpTestResult, type RoleId, type ServerConfig, type SourceType } from "../types.js";

const emit = defineEmits<{
  (e: "launched", runId: string): void;
  (e: "close"): void;
}>();

interface RepoRow {
  path: string;
  baseBranch: string;
  aiGuidelinePath: string;
}

type Mode = "jira" | "manual";
const mode = ref<Mode>("jira");

const ticketUrl = ref("");

const manualType = ref<SourceType>("feature");
const manualTitle = ref("");
const manualDescription = ref("");
const manualCriteria = ref<string[]>([""]);

const repos = ref<RepoRow[]>([{ path: "", baseBranch: "master", aiGuidelinePath: "" }]);
const submitting = ref(false);
const error = ref<string | null>(null);

// Per-role model overrides. Blank = server default (CLAUDE_MODEL / CLAUDE_MODEL_<ROLE>).
const serverConfig = ref<ServerConfig | null>(null);
const showModels = ref(false);
const models = ref<Record<RoleId, string>>(Object.fromEntries(ROLES.map((r) => [r, ""])) as Record<RoleId, string>);
const jiraTest = ref<JiraMcpTestResult | null>(null);
const jiraTesting = ref(false);
async function testJira() {
  jiraTesting.value = true;
  jiraTest.value = null;
  try {
    // Config is re-read on every request, so refresh what we show too.
    serverConfig.value = await api.getConfig();
    jiraTest.value = await api.testJira();
  } catch (e) {
    jiraTest.value = { ok: false, toolsFound: [], toolsMissing: [], serverTools: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    jiraTesting.value = false;
  }
}

onMounted(async () => {
  try {
    serverConfig.value = await api.getConfig();
  } catch {
    // Defaults are only used as placeholders; the dialog still works without them.
  }
});

function addRepo() {
  repos.value.push({ path: "", baseBranch: "master", aiGuidelinePath: "" });
}
function removeRepo(idx: number) {
  if (repos.value.length === 1) return;
  repos.value.splice(idx, 1);
}
function addCriterion() {
  manualCriteria.value.push("");
}
function removeCriterion(idx: number) {
  if (manualCriteria.value.length === 1) return;
  manualCriteria.value.splice(idx, 1);
}

async function submit() {
  error.value = null;
  submitting.value = true;
  try {
    const payloadRepos = repos.value
      .map((r) => ({
        path: r.path.trim(),
        baseBranch: r.baseBranch.trim() || undefined,
        aiGuidelinePath: r.aiGuidelinePath.trim() === "" ? undefined : r.aiGuidelinePath.trim(),
      }))
      .filter((r) => r.path.length > 0);
    if (payloadRepos.length === 0) {
      error.value = "At least one repo path is required.";
      return;
    }

    const source =
      mode.value === "jira"
        ? ({ kind: "jira" as const, ticket: "", ticketUrl: ticketUrl.value.trim() })
        : ({
            kind: "manual" as const,
            type: manualType.value,
            title: manualTitle.value.trim(),
            description: manualDescription.value.trim(),
            acceptanceCriteria: manualCriteria.value.map((c) => c.trim()).filter((c) => c.length > 0),
          });

    if (source.kind === "jira" && serverConfig.value && !serverConfig.value.jira.configured) {
      error.value = "No JIRA MCP server is configured. Configure one (see below) or describe the change manually.";
      return;
    }
    if (source.kind === "jira" && !source.ticketUrl) {
      error.value = "Enter a JIRA ticket URL or switch to manual.";
      return;
    }
    if (source.kind === "manual" && (!source.title || !source.description)) {
      error.value = "Title and description are required for a manual run.";
      return;
    }

    const modelOverrides = Object.fromEntries(
      Object.entries(models.value)
        .map(([role, m]) => [role, m.trim()])
        .filter(([, m]) => m.length > 0),
    ) as Partial<Record<RoleId, string>>;

    const { runId } = await api.launchRun({ source, repos: payloadRepos, models: modelOverrides });
    emit("launched", runId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="dialog panel">
      <h3>Launch a new run</h3>
      <p class="muted">Analyst runs immediately. Pipeline: Analyst → Developer (plan) → Unit Tester (failing tests) → Developer (implement) → Unit Tester (verify) → Integration Tester → Reviewer → E2E Tester → PR Creator. The orchestrator asks in the UI before every mutating action.</p>

      <div class="tabs">
        <button :class="{ primary: mode === 'jira' }" @click="mode = 'jira'">From JIRA ticket</button>
        <button :class="{ primary: mode === 'manual' }" @click="mode = 'manual'">Describe manually</button>
      </div>

      <template v-if="mode === 'jira'">
        <label>JIRA ticket URL</label>
        <input v-model="ticketUrl" placeholder="https://example.atlassian.net/browse/PROJ-123" />

        <div v-if="serverConfig" class="jira-box">
          <template v-if="serverConfig.jira.configured">
            <div class="row" style="gap: 8px; align-items: center">
              <span class="muted" style="font-size: 12px">JIRA MCP:</span>
              <span class="mono" style="font-size: 12px">{{ serverConfig.jira.serverName }}</span>
              <span class="chip">{{ serverConfig.jira.transport }}</span>
              <span class="muted mono" style="font-size: 11px">{{ serverConfig.jira.target }}</span>
              <div class="spacer" />
              <button @click="testJira" :disabled="jiraTesting">{{ jiraTesting ? "Testing…" : "Test connection" }}</button>
            </div>
            <div class="muted" style="font-size: 11px; margin-top: 4px">
              Tools: <span class="mono">{{ serverConfig.jira.tools?.getIssue }}</span>,
              <span class="mono">{{ serverConfig.jira.tools?.searchIssues ?? "(no search)" }}</span>,
              <span class="mono">{{ serverConfig.jira.tools?.addComment }}</span> · {{ serverConfig.jira.source }}
            </div>
            <div v-if="jiraTest" class="jira-test" :class="jiraTest.ok ? 'ok' : 'bad'">
              <template v-if="jiraTest.error">✗ {{ jiraTest.error }}</template>
              <template v-else>
                {{ jiraTest.ok ? "✓" : "✗" }} status: <strong>{{ jiraTest.status }}</strong>
                <span v-if="jiraTest.toolsMissing.length"> · missing tools: <span class="mono">{{ jiraTest.toolsMissing.join(", ") }}</span></span>
                <div v-if="jiraTest.toolsMissing.length && jiraTest.serverTools.length" class="muted" style="margin-top: 2px">
                  Server exposes: <span class="mono">{{ jiraTest.serverTools.join(", ") }}</span>
                </div>
                <div v-if="jiraTest.status === 'needs-auth'" class="muted" style="margin-top: 2px">
                  The server needs you to sign in. Complete its auth flow (e.g. run the server command once in a terminal), then test again.
                </div>
              </template>
            </div>
          </template>
          <div v-else class="jira-test bad">
            <template v-if="serverConfig.jira.error">JIRA MCP config error: {{ serverConfig.jira.error }}</template>
            <template v-else>
              No JIRA MCP server configured. Add <span class="mono">jira-mcp.json</span> at the orchestrator root
              (see <span class="mono">jira-mcp.example.json</span>) or set <span class="mono">JIRA_MCP_*</span> in <span class="mono">.env</span>
              (<span class="mono">.env</span> changes need a backend restart; <span class="mono">jira-mcp.json</span> edits don't).
              <button style="margin-left: 6px" @click="testJira" :disabled="jiraTesting">Re-check</button>
            </template>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="split">
          <div>
            <label>Type</label>
            <select v-model="manualType">
              <option value="feature">feature</option>
              <option value="change">change</option>
              <option value="fix">fix</option>
            </select>
          </div>
          <div>
            <label>Title</label>
            <input v-model="manualTitle" placeholder="Short, imperative title" />
          </div>
        </div>
        <label>Description</label>
        <textarea v-model="manualDescription" placeholder="What is the change? Why is it needed? Who is affected?"></textarea>

        <label>Acceptance criteria</label>
        <div v-for="(_, i) in manualCriteria" :key="i" class="row" style="gap: 6px; margin-top: 4px">
          <input v-model="manualCriteria[i]" :placeholder="`Criterion ${i + 1}`" />
          <button v-if="manualCriteria.length > 1" @click="removeCriterion(i)" class="danger">–</button>
        </div>
        <button @click="addCriterion" style="margin-top: 6px">+ Add criterion</button>
      </template>

      <div class="repos">
        <div class="row">
          <label style="margin:0">Target repos</label>
          <div class="spacer" />
          <button @click="addRepo">+ Add repo</button>
        </div>
        <div v-for="(r, i) in repos" :key="i" class="repo-row">
          <div class="row">
            <strong class="muted mono">#{{ i + 1 }}</strong>
            <div class="spacer" />
            <button v-if="repos.length > 1" @click="removeRepo(i)" class="danger">Remove</button>
          </div>
          <label>Absolute path</label>
          <input v-model="r.path" placeholder="C:\path\to\repo" />
          <div class="split">
            <div>
              <label>Base branch</label>
              <input v-model="r.baseBranch" placeholder="master" />
            </div>
            <div>
              <label>AI guideline doc path (optional, relative to repo)</label>
              <input v-model="r.aiGuidelinePath" placeholder="docs/ai-guideline (blank = AI_GUIDELINE_PATH_DEFAULT if present)" />
            </div>
          </div>
        </div>
      </div>

      <div class="models">
        <div class="row">
          <label style="margin:0">Models per role</label>
          <div class="spacer" />
          <button @click="showModels = !showModels">{{ showModels ? "Hide" : "Customize" }}</button>
        </div>
        <p v-if="!showModels" class="muted" style="font-size: 12px; margin: 4px 0 0">
          Using server defaults<template v-if="serverConfig">
            (e.g. Developer: <span class="mono">{{ serverConfig.models.developer }}</span>)</template>.
        </p>
        <div v-else class="model-grid">
          <template v-for="r in ROLES" :key="r">
            <span class="muted" style="font-size: 12px">{{ ROLE_LABELS[r] }}</span>
            <input v-model="models[r]" :placeholder="serverConfig?.models[r] ?? 'server default'" class="mono" />
          </template>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <div class="row" style="margin-top: 12px">
        <button @click="emit('close')" :disabled="submitting">Cancel</button>
        <div class="spacer" />
        <button class="primary" @click="submit" :disabled="submitting">
          {{ submitting ? "Launching..." : "Launch" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: grid; place-items: center; z-index: 10; }
.dialog { width: min(720px, 92vw); display: flex; flex-direction: column; gap: 8px; max-height: 92vh; overflow-y: auto; }
h3 { margin: 0 0 4px; }
label { font-size: 12px; color: var(--muted); margin-top: 8px; display: block; }
.error { color: var(--danger); }
.tabs { display: flex; gap: 6px; margin: 6px 0 2px; }
.repos { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.repo-row { border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); }
.split { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; }
.jira-box { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: var(--panel2); }
.jira-test { margin-top: 6px; font-size: 12px; }
.jira-test.ok { color: var(--success); }
.jira-test.bad { color: var(--warn); }
.models { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); }
.model-grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 10px; align-items: center; margin-top: 8px; }
@media (max-width: 640px) { .split { grid-template-columns: 1fr; } }
</style>
