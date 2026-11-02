# CLAUDE.md

This file provides guidance to AI coding assistants working with code in this repository.

## What this project is

A generic local orchestrator that drives five Claude Agent SDK sessions through a feature-development workflow (Analyst → Developer → Reviewer ⇄ Developer → Tester ⇄ Developer → PR Creator), exposed through a Vue 3 UI. It is not a library — it is a long-running Fastify server plus a single-page frontend meant to run on `localhost`. Target repos and project standards docs are configured per run; the orchestrator itself has no project-specific coupling.

A run can be sourced from either a JIRA ticket (via the `atlassian-local` MCP server) or a user-supplied manual description (type: `feature` | `change` | `fix`, plus title, description, acceptance criteria). The Analyst role branches on the source: for JIRA it fetches via MCP and may propose a JIRA comment; for manual it reads the description inline and skips the JIRA-comment flow.

## Common commands

Run everything from the repo root (`agents/`) unless noted:

- `npm run install:all` — installs root, backend, and frontend deps.
- `npm run dev` — Fastify backend on `:5174` + Vite dev server on `:5173` (concurrently).
- `npm run build` — type-checks and bundles both.
- `npm run typecheck` — backend `tsc --noEmit` + `vue-tsc --noEmit`.
- `npm run test` — backend Vitest.
- Single backend test: `npm --prefix backend run test -- <path-or-pattern>`.
- Backend only in dev: `npm --prefix backend run dev` (uses `tsx watch`).

## Auth

The SDK reuses the local Claude CLI login by default (`claude /login`). `ANTHROPIC_API_KEY` is an optional override for headless or API-billed scenarios — do NOT treat it as required when editing config or docs.

## Architecture (the big picture)

```
Vue UI ──REST + WebSocket──► Fastify orchestrator ──spawns──► Agent SDK sessions
                                      │
                                      ├─ writes/reads artifacts in a single flat folder: runs/<runId>/*.md
                                      ├─ persists per-role session ids in sessions/<runId>/<role>.json
                                      ├─ on boot: scans runs/*/run.json and resumes any mid-flight role
                                      └─ performs mutating external actions (JIRA comment, git branch creation, gh pr create)
                                         ONLY after a UI approval
```

Four load-bearing design choices that are easy to miss by reading one file:

1. **Roles never share SDK context.** Handoff is file-based: each role writes a markdown artifact that the next role reads. On a re-run (e.g. Developer re-run after Reviewer flagged issues), the orchestrator resumes that role's SDK session via `resume: <sessionId>` and attaches the new feedback artifact as input — the role keeps its own memory of its prior attempt.

2. **Roles never execute mutating external actions.** They write a *proposed* artifact (e.g. `proposed-jira-comment.md`, `pr-description.md`) and emit a terminal JSON block requesting approval. The orchestrator performs the action after the user clicks approve. This single approval surface keeps the UI authoritative and limits prompt-injection blast radius.

3. **Every role ends its turn with a structured JSON block.** The schema is in `backend/src/sdk/runRole.ts` (search for `RoleOutputSchema`). The orchestrator parses it to decide the next state transition. If a role fails to emit a valid block, the orchestrator surfaces the error in the UI rather than silently advancing.

4. **Mid-flight recovery is session-replay, not snapshotting.** `backend/src/orchestrator/recovery.ts` runs at startup; for every run whose latest attempt was `running` when the backend died, it re-issues the role with the SDK session id. There is no DB — the on-disk `run.json` plus the SDK's own session persistence is the state.

## Where things live

- `backend/src/orchestrator/workflow.ts` — the state machine. Start here when debugging flow bugs.
- `backend/src/orchestrator/recovery.ts` — startup recovery for mid-flight runs.
- `backend/src/sdk/runRole.ts` — the only place the Agent SDK is actually invoked. Streams messages to the event bus, captures `session_id` from the SDK `system` message, enforces the per-role Bash command allowlist via `canUseTool`, and wraps the loop in a transient-error retry.
- `backend/src/roles/<role>.ts` — per-role config: tool allowlist, Bash command regex allowlist, input builder (how to assemble the per-run prompt from upstream artifacts).
- `backend/src/roles/common.ts` — shared helpers for input builders. `aiGuidelineSection(record, role)` injects the "AI guideline" block into the role prompt only when the run has a resolved ai-guideline path.
- `roles/<role>.md` — the role's system prompt. **This is the first place to edit when you want to change what a role does.** No TypeScript change needed.
- `templates/*.md` — artifact scaffolds the roles fill in. Edit these to change artifact shape.
- `backend/src/external/{jiraMcp,gh,git}.ts` — all mutating external calls. Nothing else should shell out.
- `runs/<runId>/` is a single flat folder per run holding every artifact for that run — `feature-doc.md`, `adr.md`, `impl-plan.md`, `review-report.md`, `test-report.md`, one `<repoSlug>-pr-description.md` per repo, `proposed-branches.json`, and `run.json` (the state file). Role attribution for UI tabs comes from `backend/src/orchestrator/artifacts.ts :: expectedFileOwners`. The `runId` is derived from the JIRA ticket key (jira source) or a slug of the manual title (manual source), plus a short nanoid for uniqueness.
- `sessions/<runId>/<role>.json` holds the SDK session id for each role. Delete one to force that role to start a fresh SDK session.
- Both folders are gitignored.

## Role contract (terminal JSON block)

Every role ends its turn with a fenced JSON block matching:

```json
{
  "status": "done" | "awaiting_approval" | "blocked",
  "artifacts": ["runs/PROJ-123/analyst/feature-doc.md"],
  "approvalRequest": {
    "action": "post_jira_comment" | "create_test_suite" | "create_pr" | "proceed_to_next",
    "summary": "short human description",
    "payloadPath": "runs/PROJ-123/analyst/proposed-jira-comment.md"
  } | null,
  "handoff": { "nextRole": "developer", "notes": "optional" } | null
}
```

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
- **Target repo**: specified per-run in the launch dialog. Must be an existing checkout. Developer and Tester roles run commands (e.g. `npm test`) with `cwd` set to this path.

## Retry policy

`sdk/runRole.ts` classifies errors and retries transient ones with exponential backoff: `config.retry.maxAttempts` (default 3) and `config.retry.initialDelayMs` (default 1000). Non-transient (auth, 4xx, abort) fail fast.

## Target repo expectations

The orchestrator is language-agnostic in principle, but the role prompts and the per-role Bash allowlists are shaped for Node/TypeScript repos using Vitest for unit tests, git, and a GitHub origin. If you want to drive non-TS repos, you'll need to adapt the Developer / Reviewer / Tester Bash allowlists in `backend/src/roles/*.ts`.

## Gotchas

- Deleting a role's session id file is a legitimate "start over" — the role will begin from scratch next run.
- Role prompts are loaded at process start. Edit a prompt → restart backend to pick it up.
- The startup recovery pass only re-issues the latest role attempt; it does not resurrect in-flight tool-use state. If the role had just made a destructive edit before the crash, resumption may re-attempt or re-review that edit; keep role actions idempotent where feasible.
