# CLAUDE.md

This file provides guidance to AI coding assistants working with code in this repository.

## What this project is

A generic local orchestrator that drives seven Claude Agent SDK roles through a TDD feature-development workflow — Analyst → Developer (plan) → Unit Tester (failing tests) → Developer (implement) → Unit Tester (verify) → Integration Tester → Reviewer → E2E Tester → PR Creator, with fix loops back to the Developer — exposed through a Vue 3 UI. It is not a library — it is a long-running Fastify server plus a single-page frontend meant to run on `localhost`. Target repos and project standards docs are configured per run; the orchestrator itself has no project-specific coupling.

A run can be sourced from either a JIRA ticket (via the `atlassian-local` MCP server) or a user-supplied manual description (type: `feature` | `change` | `fix`, plus title, description, acceptance criteria). The Analyst role branches on the source: for JIRA it fetches via MCP and may propose a JIRA comment; for manual it reads the description inline and skips the JIRA-comment flow.

## Common commands

Run everything from the repo root (`agents/`) unless noted:

- `npm run install:all` — installs root, backend, and frontend deps.
- `npm run dev` — Fastify backend on `:5174` + Vite dev server on `:5173` (concurrently).
- `npm run build` — type-checks and bundles both.
- `npm run typecheck` — backend `tsc --noEmit` + `vue-tsc --noEmit`.
- `npm run test` — backend Vitest. `backend/test/workflow.test.ts` drives the full state machine with a scripted fake of `runRoleAgent` (no model calls); `permissions.test.ts` covers the tool guard and each role's Bash allowlist.
- Single backend test: `npm --prefix backend run test -- <path-or-pattern>`.
- Backend only in dev: `npm --prefix backend run dev` (uses `tsx watch`).

## Auth

The SDK reuses the local Claude CLI login by default (`claude /login`). `ANTHROPIC_API_KEY` is an optional override for headless or API-billed scenarios — do NOT treat it as required when editing config or docs.

## Architecture (the big picture)

```
Vue UI ──REST + WebSocket──► Fastify orchestrator ──spawns──► Agent SDK sessions
                                      │
                                      ├─ writes/reads artifacts in per-role folders: runs/<runId>/<role>/*.md
                                      ├─ persists per-role session ids in sessions/<runId>/<role>.json
                                      ├─ on boot: scans runs/*/run.json and resumes any mid-flight role
                                      └─ performs mutating external actions (JIRA comment, git branch creation, gh pr create)
                                         ONLY after a UI approval
```

Five load-bearing design choices that are easy to miss by reading one file:

1. **Roles never share SDK context.** Handoff is file-based: each role writes a markdown artifact that the next role reads. On a re-run (e.g. Developer re-run after Reviewer flagged issues), the orchestrator resumes that role's SDK session via `resume: <sessionId>` and attaches the new feedback artifact as input — the role keeps its own memory of its prior attempt.

2. **Roles never execute mutating external actions.** They write a *proposed* artifact (e.g. `proposed-jira-comment.md`, `pr-description.md`) and emit a terminal JSON block requesting approval. The orchestrator performs the action after the user clicks approve. This single approval surface keeps the UI authoritative and limits prompt-injection blast radius.

3. **Every role ends its turn with a structured JSON block.** The schema is in `backend/src/sdk/runRole.ts` (search for `RoleOutputSchema`). The orchestrator parses it to decide the next state transition. If a role fails to emit a valid block, the orchestrator surfaces the error in the UI rather than silently advancing.

4. **The state machine, not the role, picks the next step.** On `status: "done"` the orchestrator advances by the current run state (`nextAfterDone` in `workflow.ts`); a role's `handoff` is only honoured on `blocked` (hand-backs to the Developer / Unit Tester, which count as fix loops). The Unit Tester runs in two phases told apart by run state (`unit_tests_red_running` / `unit_tests_green_running`), resuming the same SDK session.

5. **Mid-flight recovery is session-replay, not snapshotting.** `backend/src/orchestrator/recovery.ts` runs at startup; for every run whose latest attempt was `running` when the backend died, it re-issues the role with the SDK session id. There is no DB — the on-disk `run.json` plus the SDK's own session persistence is the state.

## Where things live

- `backend/src/orchestrator/workflow.ts` — the state machine. Start here when debugging flow bugs.
- `backend/src/orchestrator/recovery.ts` — startup recovery for mid-flight runs.
- `backend/src/sdk/runRole.ts` — the only place the Agent SDK is actually invoked. Streams messages to the event bus, captures `session_id` and cost/usage from the SDK messages, and wraps the loop in a transient-error retry.
- `backend/src/sdk/permissions.ts` — the tool guard (pure functions, unit-tested). Called from both a `PreToolUse` hook and `canUseTool`, because the SDK auto-approves anything in `allowedTools` without calling `canUseTool`. Only read-only tools go in `allowedTools`; Bash/Write/Edit/MultiEdit/NotebookEdit are always checked (Bash allowlist + no shell chaining; writes limited by the role's `writeScope`).
- `backend/src/roles/<role>.ts` — per-role config: tool allowlist, Bash regex allowlist (built from `BASH` in `common.ts`), `writeScope`, input builder (how to assemble the per-run prompt from upstream artifacts).
- `backend/src/roles/common.ts` — shared helpers for input builders. `aiGuidelineSection(record, role)` injects the "AI guideline" block only when the run has a resolved ai-guideline path; `orchestratorSection(ctx)` renders orchestrator signals, hand-back notes and user feedback.
- `backend/src/orchestrator/runStore.ts` — `run.json` persistence. Records are cached in memory (one shared object per run, so concurrent callers can't overwrite each other's changes) and written atomically (temp file + rename). Also migrates pre-split runs (`tester` → `e2eTester`).
- `roles/<role>.md` — the role's system prompt. **This is the first place to edit when you want to change what a role does.** No TypeScript change needed.
- `templates/*.md` — artifact scaffolds the roles fill in. Edit these to change artifact shape.
- `backend/src/external/{jiraMcp,gh,git}.ts` — all mutating external calls. Nothing else should shell out.
- `runs/<runId>/` holds `run.json` (the state file) and one subfolder per role (`analyst/feature-doc.md`, `developer/adr.md` + `impl-plan.md`, `unitTester/unit-test-report.md`, `integrationTester/integration-test-report.md`, `reviewer/review-report.md` + `review-findings.json`, `e2eTester/e2e-test-report.md`, `prCreator/<repoSlug>-pr-description.md`) plus `orchestrator/proposed-branches.json`. Role attribution for UI tabs comes from the subfolder name (`backend/src/orchestrator/artifacts.ts`). The `runId` is derived from the JIRA ticket key (jira source) or a slug of the manual title (manual source), plus a short nanoid for uniqueness.
- `sessions/<runId>/<role>.json` holds the SDK session id for each role. Delete one to force that role to start a fresh SDK session.
- Both folders are gitignored.

## Role contract (terminal JSON block)

Every role ends its turn with a fenced JSON block matching:

```json
{
  "status": "done" | "awaiting_approval" | "blocked",
  "artifacts": ["runs/PROJ-123-abc123/analyst/feature-doc.md"],
  "approvalRequest": {
    "action": "post_jira_comment" | "create_test_suite" | "create_pr" | "proceed_to_next",
    "summary": "short human description",
    "payloadPaths": ["runs/PROJ-123-abc123/analyst/proposed-jira-comment.md"]
  } | null,
  "handoff": { "nextRole": "developer" | "unitTester" | …, "notes": "optional" } | null
}
```

`handoff` only matters with `status: "blocked"` (send work back to another role). On `done` the state machine decides the next role.

When editing role prompts, keep the terminal-JSON-block instruction verbatim — the orchestrator will mark the run `failed` otherwise.

## AI guideline doc (per-repo, optional)

The orchestrator supports an optional per-repo AI guideline document. In code and in `run.json` it lives on each `RepoTarget` as `aiGuidelinePath`:

- Launch dialog field (per repo row): "AI guideline doc path (optional, relative to repo)".
- Default: `AI_GUIDELINE_PATH_DEFAULT` env var (ships with `docs/ai-guideline`), but only applied if that folder actually exists in the target repo. Otherwise the repo records `aiGuidelinePath: null`.
- `backend/src/roles/common.ts :: aiGuidelineSection(record, role)` returns a markdown block injected into the role prompt. It is empty when no repo in the run has a resolved ai-guideline, so unrelated repos get no phantom guideline instruction.
- The role prompt files (`roles/*.md`) must stay generic — do not hard-code any project-specific terminology; let `aiGuidelineSection` carry the per-run reference.

## External integrations

- **JIRA**: via the `atlassian-local` MCP server. The Analyst role reads via MCP tools (`mcp__atlassian-local__getJiraIssue` etc.); the orchestrator *posts* via MCP after approval (`backend/src/external/jiraMcp.ts`).
- **GitHub**: via `gh` CLI. The user must be authenticated (`gh auth status`).
- **Target repo**: specified per-run in the launch dialog. Must be an existing checkout. Developer and tester roles run commands (e.g. `npm test`) with `cwd` set to the first repo, or `cd <repo> && …` for the others.

## Models, limits, and cost

- Model per role: `config.models` (`CLAUDE_MODEL`, overridden by `CLAUDE_MODEL_<ROLE>`), overridden per run by `RunRecord.models` from the launch dialog. Each attempt records the model it used.
- Each attempt records `costUsd`, `numTurns` and token usage from the SDK `result` message; `totalCostUsd(record)` sums them.
- `MAX_FIX_ITERATIONS` (default 3) caps fix loops; `MAX_RUN_COST_USD` (default off) pauses before the next role once spent. Both pause the run (`state: "paused"`, `pauseReason`). "Jump → role" resumes, resets the fix counter and ignores the budget for that one role.
- `REVIEW_AUTO_ROUTE=true` decides the review gate from `review-findings.json`.
- A role that reports `blocked` without a hand-off pauses the run (fix the cause, then Jump); errors and invalid output fail it.

## Retry policy

`sdk/runRole.ts` classifies errors and retries transient ones with exponential backoff: `config.retry.maxAttempts` (default 3) and `config.retry.initialDelayMs` (default 1000). Non-transient (auth, 4xx, abort) fail fast.

## Target repo expectations

The orchestrator is language-agnostic in principle, but the role prompts and the per-role Bash allowlists are shaped for Node/TypeScript repos using Vitest for unit tests, git, and a GitHub origin. If you want to drive non-TS repos, you'll need to adapt the `BASH` patterns in `backend/src/roles/common.ts` and the per-role allowlists in `backend/src/roles/*.ts`.

## Gotchas

- Deleting a role's session id file is a legitimate "start over" — the role will begin from scratch next run.
- Role prompts (`roles/*.md`) are read from disk each time a role starts, so prompt edits apply to the next role invocation without a restart. TypeScript changes still need a restart (`tsx watch` does that in dev).
- The startup recovery pass only re-issues the latest role attempt; it does not resurrect in-flight tool-use state. If the role had just made a destructive edit before the crash, resumption may re-attempt or re-review that edit; keep role actions idempotent where feasible.
