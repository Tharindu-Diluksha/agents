<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api.js";
import ModelEffortPicker from "./ModelEffortPicker.vue";
import ContextEditor from "./ContextEditor.vue";
import { emptyDraft, hasContent, toContextUpload } from "../composables/contextDraft.js";
import { REQUIRED_ROLES, ROLE_HINTS, ROLE_LABELS, ROLES, type ContextDraft, type EffortLevel, type JiraMcpTestResult, type RoleId, type ServerConfig, type SourceType, type StackId, type StackProject } from "../types.js";

const emit = defineEmits<{
  (e: "launched", runId: string): void;
  (e: "close"): void;
}>();

interface RepoRow {
  path: string;
  baseBranch: string;
  aiGuidelinePath: string;
  /** Checked stacks. Pre-filled from detection; empty = let the server detect. */
  stacks: StackId[];
  /** What auto-detection found for the current path, with the folder of each stack. */
  detected: StackProject[] | null;
  detectError: string | null;
}

const newRow = (): RepoRow => ({ path: "", baseBranch: "master", aiGuidelinePath: "", stacks: [], detected: null, detectError: null });

const lastDetected = new WeakMap<RepoRow, string>();
async function detect(r: RepoRow) {
  const path = r.path.trim();
  if (lastDetected.get(r) === path) return; // blur without a change keeps the user's ticks
  lastDetected.set(r, path);
  r.detected = null;
  r.detectError = null;
  if (!path) return;
  try {
    r.detected = (await api.detectStacks(path)).projects;
    r.stacks = [...new Set(r.detected.map((p) => p.stack))];
  } catch {
    r.detectError = "path not found";
  }
}

function toggleStack(r: RepoRow, id: StackId) {
  r.stacks = r.stacks.includes(id) ? r.stacks.filter((s) => s !== id) : [...r.stacks, id];
}

/** Folders detection found for a stack in this repo, e.g. "prep-app/"; root shows as "root". */
function foldersOf(r: RepoRow, id: StackId): string {
  const dirs = (r.detected ?? []).filter((p) => p.stack === id).map((p) => (p.dir === "." ? "root" : `${p.dir}/`));
  return dirs.join(", ");
}

function stackLabel(id: StackId): string {
  return serverConfig.value?.stacks.find((s) => s.id === id)?.label ?? id;
}

type Mode = "jira" | "manual";
const mode = ref<Mode>("jira");

const ticketUrl = ref("");

const manualType = ref<SourceType>("feature");
const manualTitle = ref("");
const manualDescription = ref("");
const manualCriteria = ref<string[]>([""]);

const repos = ref<RepoRow[]>([newRow()]);
/** Extra notes / images (mockups) sent with the launch. */
const context = ref<ContextDraft>(emptyDraft());
/** worktree = isolated copy per run; in-place = a new branch in the user's own checkout. */
const workspace = ref<"worktree" | "in-place">("worktree");
const submitting = ref(false);
const error = ref<string | null>(null);

const serverConfig = ref<ServerConfig | null>(null);

// Agents: which roles run, and the model / effort per role ("" = server default; see ModelEffortPicker).
const perRole = <T,>(v: T) => Object.fromEntries(ROLES.map((r) => [r, v])) as Record<RoleId, T>;
const enabled = ref(perRole(true));
const models = ref(perRole(""));
const efforts = ref(perRole<EffortLevel | "">(""));
const requiredRoles = computed<readonly RoleId[]>(() => serverConfig.value?.requiredRoles ?? REQUIRED_ROLES);
const isRequired = (r: RoleId) => requiredRoles.value.includes(r);
const pipeline = computed(() => ROLES.filter((r) => enabled.value[r]).map((r) => ROLE_LABELS[r]).join(" → "));
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
  repos.value.push(newRow());
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
        // Ticked stacks override detection (the server keeps the folders it detects for them); none = detect.
        stacks: r.stacks.length > 0 ? r.stacks : undefined,
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

    const modelOverrides: Partial<Record<RoleId, string>> = {};
    const effortOverrides: Partial<Record<RoleId, EffortLevel>> = {};
    for (const r of ROLES) {
      if (!enabled.value[r]) continue;
      const model = models.value[r].trim();
      if (model) modelOverrides[r] = model;
      const effort = efforts.value[r];
      if (effort) effortOverrides[r] = effort;
    }
    const disabledRoles = ROLES.filter((r) => !enabled.value[r] && !isRequired(r));

    const { runId } = await api.launchRun({
      source,
      repos: payloadRepos,
      models: modelOverrides,
      efforts: effortOverrides,
      disabledRoles,
      context: hasContent(context.value) ? await toContextUpload(context.value) : undefined,
      workspace: workspace.value,
    });
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
      <p class="muted">Analyst runs immediately. Pipeline: {{ pipeline }} (choose the agents below). The orchestrator asks in the UI before every mutating action.</p>

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

      <div class="context-box">
        <label style="margin:0">Extra context and mockups <span style="font-weight: normal">(optional)</span></label>
        <div class="muted" style="font-size: 11px; margin: 2px 0 6px">
          Notes and images that aren't in the {{ mode === "jira" ? "ticket" : "description" }}, e.g. UI mockups. Every agent gets them; you can add more later from the run page.
        </div>
        <ContextEditor v-model="context" />
      </div>

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
          <input v-model="r.path" placeholder="C:\path\to\repo" @blur="detect(r)" />
          <div class="split3">
            <div>
              <label>Base branch</label>
              <input v-model="r.baseBranch" placeholder="master" />
            </div>
            <div>
              <label>AI guideline doc path (optional, relative to repo)</label>
              <input v-model="r.aiGuidelinePath" placeholder="docs/ai-guideline (blank = AI_GUIDELINE_PATH_DEFAULT if present)" />
            </div>
          </div>
          <label>Stacks <span style="font-weight: normal">(tick every one the repo uses — a monorepo can have several)</span></label>
          <div class="stack-grid">
            <label v-for="s in serverConfig?.stacks ?? []" :key="s.id" class="stack-opt" :class="{ on: r.stacks.includes(s.id) }" :title="s.summary">
              <input type="checkbox" :checked="r.stacks.includes(s.id)" @change="toggleStack(r, s.id)" />
              <span>{{ s.label }}</span>
              <span v-if="foldersOf(r, s.id)" class="muted mono folder">{{ foldersOf(r, s.id) }}</span>
            </label>
          </div>
          <div class="muted" style="font-size: 11px; margin-top: 2px">
            <template v-if="r.detectError">{{ r.detectError }}</template>
            <template v-else-if="r.detected && r.detected.length">
              Detected: {{ r.detected.map((p) => `${stackLabel(p.stack)} (${p.dir === "." ? "root" : p.dir + "/"})`).join(" + ") }}
            </template>
            <template v-else-if="r.detected">Nothing detected — tick the stack(s) this repo uses</template>
            <template v-else>Enter the path to detect stacks; leave all unticked to detect at launch.</template>
          </div>
        </div>
      </div>

      <div class="workspace">
        <label style="margin:0">Where the agents work</label>
        <label class="ws-opt">
          <input type="radio" value="worktree" v-model="workspace" />
          <span>
            <strong>Isolated worktree</strong> (recommended)
            <span class="muted ws-hint">A separate copy of each repo under the orchestrator's <span class="mono">worktrees/</span> folder, with its own dependencies and ports. Your checkout is never touched, and several runs can work on the same repo at once.</span>
          </span>
        </label>
        <label class="ws-opt">
          <input type="radio" value="in-place" v-model="workspace" />
          <span>
            <strong>New branch in my checkout</strong>
            <span class="muted ws-hint">The agents work directly in the repo path above. After you approve the plan and branch name, the feature branch is created there from the latest base branch. The checkout must be clean and on the base branch, it uses your existing dependencies, and only one such run per repo at a time — don't edit files there while the run is active.</span>
          </span>
        </label>
      </div>

      <div class="models">
        <label style="margin:0">Agents, models and effort</label>
        <div class="muted" style="font-size: 11px; margin-top: 2px">
          Untick an agent to leave it out of this run. {{ requiredRoles.map((r) => ROLE_LABELS[r]).join(", ") }} always run.
          Higher effort means deeper reasoning but more tokens and time; a level the model doesn't support may be lowered automatically.
        </div>
        <div class="model-grid">
          <template v-for="r in ROLES" :key="r">
            <label class="agent-opt" :class="{ off: !enabled[r] }" :title="ROLE_HINTS[r]">
              <input type="checkbox" v-model="enabled[r]" :disabled="isRequired(r)" />
              <span>
                {{ ROLE_LABELS[r] }}
                <span v-if="isRequired(r)" class="chip req">required</span>
                <span class="muted agent-hint">{{ ROLE_HINTS[r] }}</span>
              </span>
            </label>
            <ModelEffortPicker v-model:model="models[r]" v-model:effort="efforts[r]" :role="r" :config="serverConfig" :disabled="!enabled[r]" />
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
.context-box { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); }
.repos { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
.repo-row { border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); }
.split { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; }
.split3 { display: grid; grid-template-columns: 1fr 2fr; gap: 10px; }
@media (max-width: 640px) { .split3 { grid-template-columns: 1fr; } }
.stack-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 4px 8px; margin-top: 4px; }
.stack-opt { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 13px; color: var(--text); cursor: pointer; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; }
.stack-opt.on { border-color: var(--accent); }
.stack-opt input { width: auto; margin: 0; }
.stack-opt .folder { font-size: 10px; margin-left: auto; }
.jira-box { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: var(--panel2); }
.jira-test { margin-top: 6px; font-size: 12px; }
.jira-test.ok { color: var(--success); }
.jira-test.bad { color: var(--warn); }
.workspace { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); display: flex; flex-direction: column; gap: 6px; }
.ws-opt { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 13px; color: var(--text); cursor: pointer; }
.ws-opt input { width: auto; margin-top: 3px; }
.ws-hint { display: block; font-size: 11px; margin-top: 2px; }
.models { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; padding: 10px; background: var(--panel2); }
.model-grid { display: grid; grid-template-columns: 1fr minmax(260px, 360px); gap: 8px 12px; align-items: center; margin-top: 8px; }
.agent-opt { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 13px; color: var(--text); cursor: pointer; }
.agent-opt input { width: auto; margin-top: 3px; }
.agent-opt.off { opacity: 0.55; }
.agent-hint { display: block; font-size: 11px; }
.chip.req { font-size: 10px; margin-left: 4px; }
@media (max-width: 640px) { .model-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .split { grid-template-columns: 1fr; } }
</style>
