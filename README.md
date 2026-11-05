# Agent Orchestrator

A generic multi-agent Claude orchestrator that takes a JIRA ticket (or a manual description) through analysis → TDD implementation → unit / integration tests → review → end-to-end tests → GitHub PR, driven through a small Vue UI. Each role runs in its own Claude Agent SDK session; re-runs resume that same session; roles hand off through markdown artifact files on disk.

## Roles

| Role | Reads | Writes | Mutating actions (orchestrator-gated) |
| ---- | ----- | ------ | ------------------------------------- |
| Product Analyst | JIRA ticket or manual description, ai-guideline doc (optional) | `feature-doc.md` (numbered `AC-n` criteria), optionally `proposed-jira-comment.md` | Post JIRA comment |
| Developer | feature doc, plan, test/review reports | `adr.md`, `impl-plan.md` (incl. test plan), source edits | — (plan requires approval; branches created by the orchestrator) |
| Unit Tester | feature doc, plan | failing unit tests first (RED), then verifies them (GREEN); `unit-test-report.md` | — |
| Integration Tester | feature doc, plan, unit report | integration tests, `integration-test-report.md` | — |
| Code Reviewer | diff vs base, feature doc, ADR, plan, test reports | `review-report.md`, `review-findings.json` | — |
| E2E Tester | feature doc, plan, integration report | Playwright tests, `e2e-test-report.md` | Create a new Playwright suite |
| PR Creator | all prior artifacts | one `<repo>-pr-description.md` per repo, with an AC → tests table | Create the GitHub PR(s) |

Flow:

```
Analyst → [approve] → Developer (plan) → [approve plan] → [approve branch names]
  → Unit Tester (RED: failing tests) → Developer (implement) → Unit Tester (GREEN: verify)
  → Integration Tester → Reviewer → [approve / send back] → E2E Tester → PR Creator → [approve PR]
```

Any tester that finds an application bug, or a review sent back for fixes, returns the work to the Developer; the change then goes through Unit (GREEN) → Integration → Review → E2E again. After `MAX_FIX_ITERATIONS` such loops the run pauses for you. Every mutating external action needs a UI click.

## Models

Each role can run on its own model:

- `CLAUDE_MODEL` — default for every role.
- `CLAUDE_MODEL_<ROLE>` — per-role default (`ANALYST`, `DEVELOPER`, `UNIT_TESTER`, `INTEGRATION_TESTER`, `REVIEWER`, `E2E_TESTER`, `PR_CREATOR`).
- Launch dialog → "Models per role" — overrides for a single run.

## Running several features in parallel

You can launch several runs at once, including on the same repo:

- **Isolated worktrees.** Each run gets its own git worktree of every target repo under `worktrees/<runId>/<repo>`. It's created when the Developer first starts: detached at the latest `origin/<base>`, with dependencies installed (`npm ci`, pnpm or yarn, by lockfile) and any `WORKTREE_COPY_FILES` (e.g. `.env.test`) copied in. At the branch gate that worktree switches to the approved branch. Your own checkout is never switched or modified.
- **Branch names never collide.** Proposals always come from `BRANCH_NAME_TEMPLATE`. If that name is already checked out in another worktree (another run, or your checkout), a run-specific suffix is suggested. If you force a taken name, the gate stays open with an explanation.
- **Shared session limit.** At most `MAX_CONCURRENT_ROLES` (default 2) role sessions run at once across all runs; others show as **queued** and start first come, first served. Installing dependencies doesn't take a slot. The run list shows slot usage.
- **Cleanup.** "Remove worktrees" on a finished, failed or paused run deletes its worktrees and keeps the branches. Uncommitted changes need a confirmation. If the run continues later, the worktree is re-created on its branch.
- **Ports per run.** Each run reserves a block of ports (`PORT_RANGE_START`, `PORT_BLOCK_SIZE`) while it has worktrees. Role sessions get it as `PORT`, `E2E_PORT`, `E2E_BASE_URL`, `ORCH_PORT_BASE` and `ORCH_PORT_COUNT`, and are told to start every server on those ports. If a repo's `playwright.config` hard-codes a port, the E2E Tester switches it to read `E2E_PORT` / `E2E_BASE_URL` (with the old value as fallback).
- **Overlap warnings.** After each role, the orchestrator compares the files each active run changes (committed, uncommitted and new) per repo. Files touched by two runs show as a warning on both run pages, a chip in the run list, and a notification.
- **Up to date before the PR.** Before the PR Creator runs, each branch is rebased onto the latest base (or merged, if the branch was already pushed). Conflicts go back to the Developer with the merge in progress, and the change goes through verification again. The PR Creator is told when a rebase happened after the tests ran.
- **Stream history.** Every event is saved to `runs/<runId>/events.jsonl`, so a run's role stream survives reloads, switching between runs and backend restarts.
- **Needs your attention.** The run list shows runs waiting on you (open approval, paused, or failed in the last 24h); the header shows the count and the tab title shows it as `(N)`. "Enable notifications" gives a desktop notification when a run needs approval, pauses, fails, finishes or starts overlapping another run while the tab is in the background.
- **One backend per state folder.** The backend takes a lock (`runs/.orchestrator.lock`) at startup and refuses to start if another live backend holds it.

Runs created before this change keep working directly in the checkout.

Run state stays in plain files (`runs/<runId>/run.json`): each run has its own file and a single backend process writes it, so no database is needed.

## Token usage

The run page has a **Token usage** table: per role, the model, number of attempts, input, output, cache-read and cache-write tokens, total tokens and cost, plus a run total. A running role's numbers update live. The role tabs and the run list show token and cost totals too.

## JIRA MCP server

Only needed for runs launched from a JIRA ticket. Configure it either way:

- **File**: copy `jira-mcp.example.json` to `jira-mcp.json` (gitignored) and edit it. Changes apply without a restart. `JIRA_MCP_CONFIG` can point to a different file.
- **Env vars**: `JIRA_MCP_COMMAND` + `JIRA_MCP_ARGS` (stdio), or `JIRA_MCP_URL` + `JIRA_MCP_TRANSPORT` + `JIRA_MCP_HEADERS` (http/sse). See `.env.example`.

`server` uses the same shape as a Claude Code `.mcp.json` entry. Strings can reference env vars as `${NAME}`, so tokens can stay in `.env`. If your server's tool names differ from Atlassian's (`getJiraIssue`, `searchJiraIssuesUsingJql`, `addCommentToJiraIssue`), set them under `tools` (or `JIRA_MCP_TOOL_*`).

The launch dialog's JIRA tab shows the configured server and has a **Test connection** button that reports the connection status and whether the configured tools exist. The Analyst gets the read tools, the Developer can fetch the issue, and only the orchestrator can post a comment, after you approve it. Manual-description runs never get JIRA access.

## Guard rails

- **Tool permissions**: each role only gets its listed tools. Bash, Write and Edit are always checked by the orchestrator (a `PreToolUse` hook plus `canUseTool`): Bash commands must match the role's allowlist and may not chain (`;`, `&&`, pipes, redirects, `$(…)`), except for a leading `cd <repo> && `. File writes are limited to the target repos (or only the run folder, for Analyst / Reviewer / PR Creator), never inside `.git`.
- **Fix-loop cap**: `MAX_FIX_ITERATIONS` (default 3).
- **Cost budget**: `MAX_RUN_COST_USD` (default 0 = off) pauses the run before the next role once spent.
- **Review auto-routing** (opt-in): `REVIEW_AUTO_ROUTE=true` routes the review gate from `review-findings.json`.
- **Pause / abort**: Abort stops the running SDK session and pauses the run; "Jump → role" resumes from any role.

## Also available as a Claude Code plugin

`plugins/jira-to-pr/` packages the same workflow as a **Claude Code plugin**: one skill (`/jira-to-pr:run <ticket or description>`) whose main session orchestrates seven role subagents, with approvals in chat instead of this UI. It uses the same artifact templates, so you can run both on the same ticket and compare cost and results. The app keeps the stronger guard rails (enforced allowlists, worktrees, budgets). See [plugins/jira-to-pr/README.md](plugins/jira-to-pr/README.md) for install, models and the comparison guide.

## Supported stacks

TypeScript/Node, Node (JS), Vue, React, C#/.NET, Python and Go. The launch dialog detects each repo's stack from its files (you can override it). The stack decides:
- which test, lint, build and audit commands each role may run;
- how a new worktree's dependencies are installed (npm/pnpm/yarn, `dotnet restore`, uv/poetry/pip into a `.venv`, `go mod download`);
- the testing guidance each role gets, e.g. Vitest + Vue Test Utils, React Testing Library, xUnit/NUnit + `WebApplicationFactory`, pytest + test clients, `go test` + `httptest`, Playwright for E2E.

Role prompts share their common rules with the Claude Code plugin through `prompts/shared/`. Run `npm run sync:prompts` after editing a fragment or a template.

## Auth

By default the Agent SDK reuses your local Claude CLI login — run `claude /login` once with your Max/Pro account and the orchestrator's sessions will bill against that subscription. Set `ANTHROPIC_API_KEY` in `.env` only if you want to pin billing to an API account or run headless.

## Quick start

```bash
npm run install:all
cp .env.example .env   # optional ANTHROPIC_API_KEY; configure AI_GUIDELINE_PATH_DEFAULT if your repos keep their ai-guideline doc in a different folder
npm run dev
```

Open http://127.0.0.1:5173 (frontend dev server; backend on `:5174`).

In the launch dialog, pick a source — a JIRA ticket URL *or* a manual description (type: feature/change/fix, title, body, acceptance criteria) — and one or more target repos. For each repo, enter:

- the absolute path,
- the base branch (defaults to `master`),
- an optional path (relative to the repo) to an AI guideline doc. If left blank, the orchestrator uses `AI_GUIDELINE_PATH_DEFAULT` from `.env` — but only if that folder actually exists in the target repo. If no ai-guideline doc resolves, the roles get no ai-guideline instruction at all.

## Where things live

- `backend/` — Fastify orchestrator + Agent SDK sessions.
- `frontend/` — Vue 3 UI.
- `roles/*.md` — system prompts (edit these to change role behavior; no code change needed).
- `templates/*.md` — artifact scaffolds the roles fill in.
- `runs/<runId>/<role>/` — role artifacts for a run, plus `runs/<runId>/run.json` (state) (gitignored).
- `sessions/<runId>/<role>.json` — persisted SDK session ids so re-runs resume (gitignored).

See `CLAUDE.md` for guidance aimed at future Claude Code sessions working on this repo.

## Startup resume + retry

The orchestrator survives restarts: on boot it scans `runs/*/run.json` for runs whose latest role attempt was still `running` and re-issues that role with its SDK session id, so the model picks up where it left off.

Transient SDK errors (network reset, timeout, 5xx, rate limit) are retried with exponential backoff (3 attempts by default; configurable via `RUN_RETRY_MAX_ATTEMPTS` and `RUN_RETRY_INITIAL_DELAY_MS`). Auth and 4xx errors fail fast.
