# Agent Orchestrator

A generic multi-agent Claude orchestrator that takes a JIRA ticket through analysis → implementation → review → UI tests → GitHub PR, driven through a small Vue UI. Each role runs in its own Claude Agent SDK session; re-runs resume that same session; roles hand off through markdown artifact files on disk.

## Roles

| Role | Reads | Writes | Mutating actions (orchestrator-gated) |
| ---- | ----- | ------ | ------------------------------------- |
| Product Analyst | JIRA ticket or manual description, ai-guideline doc (optional) | `feature-doc.md`, optionally `proposed-jira-comment.md` | Post JIRA comment |
| Developer | feature doc, JIRA ticket, ai-guideline doc (optional) | `adr.md`, `impl-plan.md`, source edits in target repo | — (plan requires user approval before implementing) |
| Code Reviewer | diff, feature doc, ADR, impl plan, ai-guideline doc (optional) | `review-report.md` | — |
| Tester | feature doc, target repo | `test-report.md`, Playwright suite edits | Create a new Playwright suite |
| PR Creator | all prior artifacts | `pr-description.md` | Create the GitHub PR |

Flow: Analyst → Developer → Reviewer ⇄ Developer → Tester ⇄ Developer → PR Creator. Loops run automatically; every forward transition and every mutating external action requires a UI click.

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
- `runs/<ticket>/<role>/` — role artifacts for a given ticket (gitignored).
- `sessions/<ticket>/<role>.json` — persisted SDK session ids so re-runs resume (gitignored).

See `CLAUDE.md` for guidance aimed at future Claude Code sessions working on this repo.

## Startup resume + retry

The orchestrator survives restarts: on boot it scans `runs/*/run.json` for runs whose latest role attempt was still `running` and re-issues that role with its SDK session id, so the model picks up where it left off.

Transient SDK errors (network reset, timeout, 5xx, rate limit) are retried with exponential backoff (3 attempts by default; configurable via `RUN_RETRY_MAX_ATTEMPTS` and `RUN_RETRY_INITIAL_DELAY_MS`). Auth and 4xx errors fail fast.
