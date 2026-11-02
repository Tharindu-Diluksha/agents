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

The run page shows the model and SDK-reported cost per role, and the total cost per run.

## Guard rails

- **Tool permissions**: each role only gets its listed tools. Bash, Write and Edit are always checked by the orchestrator (a `PreToolUse` hook plus `canUseTool`): Bash commands must match the role's allowlist and may not chain (`;`, `&&`, pipes, redirects, `$(…)`), except for a leading `cd <repo> && `. File writes are limited to the target repos (or only the run folder, for Analyst / Reviewer / PR Creator), never inside `.git`.
- **Fix-loop cap**: `MAX_FIX_ITERATIONS` (default 3).
- **Cost budget**: `MAX_RUN_COST_USD` (default 0 = off) pauses the run before the next role once spent.
- **Review auto-routing** (opt-in): `REVIEW_AUTO_ROUTE=true` routes the review gate from `review-findings.json`.
- **Pause / abort**: Abort stops the running SDK session and pauses the run; "Jump → role" resumes from any role.

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
