# jira-to-pr — the pipeline as a Claude Code plugin

The same TDD feature workflow as the orchestrator app in this repo, but running **inside one Claude Code session**:

```
/jira-to-pr:run PROJ-123
/jira-to-pr:run "Add CSV export to the widgets page. AC: ..."
```

The main session acts as the orchestrator. Each role is a **subagent** with its own tool list:

```
Analyst → [approve] → Developer (plan) → [approve] → [branch name]
  → Unit Tester (RED: failing tests) → Developer (implement) → Unit Tester (GREEN: verify)
  → Integration Tester → Reviewer → [fix / continue] → E2E Tester → sync with base
  → PR Writer → [approve] → push + gh pr create
```

You approve each gate in chat (multiple-choice questions, with free-text "Other" for feedback). App-bugs found by a tester, or a review you send back, loop to the Developer and the change is verified again (max 3 loops before it asks you).

Artifacts use the same templates as the orchestrator app and are written to `<repo>/.jira-to-pr/<run-id>/` (added to `.git/info/exclude`, never committed): `ticket.md`, `feature-doc.md`, `adr.md`, `impl-plan.md`, the unit/integration/E2E test reports, `review-report.md` + `review-findings.json`, `pr-description.md`, plus `state.md` (for resuming) and `ledger.md` (per-call usage).

## Install

From GitHub (the repo is a plugin marketplace):

```bash
claude plugin marketplace add Tharindu-Diluksha/agents
```

```bash
claude plugin install jira-to-pr@tharindu-agents
```

Or try it from a local checkout without installing:

```bash
claude --plugin-dir /path/to/agents/plugins/jira-to-pr
```

Then, inside the target repo: `/jira-to-pr:run <ticket or description>`.

### Requirements

- Run Claude Code **in the target repo** with a clean working tree.
- `git` and an authenticated `gh` CLI for the final push + PR.
- For JIRA tickets: a JIRA/Atlassian MCP server connected to your Claude Code session. Only the main session uses it: the subagents read `ticket.md`, and a comment is posted only after you approve it. Without it, the skill asks you to paste the ticket.
- Supported stacks, same as the app: TypeScript/Node, Node (JS), Vue, React, C#/.NET, Python and Go. The skill detects the stack and the subagents read their section of `skills/run/reference/stacks.md`, which lists frameworks, conventions and commands.

## Models per role

Each subagent uses, in order: a `model:` line in its frontmatter (`plugins/jira-to-pr/agents/<role>.md` — add e.g. `model: opus` or `model: claude-sonnet-5-5`), else the `CLAUDE_CODE_SUBAGENT_MODEL` env var, else your session's model (`/model`). The orchestrating main session always uses your session model.

## Comparing cost with the orchestrator app

The two approaches spend tokens differently:

| | Orchestrator app | This plugin |
|---|---|---|
| Sessions | One SDK session per role, resumed on re-runs | One main session + a subagent per step (resumed for the same role when possible) |
| Hand-over | Markdown artifacts on disk | Same artifacts on disk; only short `## Result` blocks return to the main session |
| What grows | Each role's own session history | The main session's history (every gate, every result) plus each subagent's |
| Per-role cost | Shown per role/attempt in the run page's **Token usage** table | `ledger.md` rows (tokens/tool uses/duration as the Agent tool reports them) |
| Total cost | Run total in the UI and run list | `/usage` (alias `/cost`) at the end of the session |

For a fair comparison:

1. Use the **same ticket** on the **same repo commit** (e.g. two clones or worktrees, both starting from the same base).
2. Use the **same models per role**: `CLAUDE_MODEL` / `CLAUDE_MODEL_<ROLE>` for the app, and the `model:` lines (or `CLAUDE_CODE_SUBAGENT_MODEL`) for the plugin.
3. Make the **same gate decisions**, and note the fix-loop count on each side, since loops dominate cost.
4. Record the app's run total and per-role table, and the plugin's `/usage` total and `ledger.md`.
5. Compare the outcome too: tests green, review findings, PR quality.

Run the plugin in a fresh session, because earlier conversation in the same session adds to its cost.

## How it differs from the app (guard rails)

The orchestrator app **enforces** its rules in code. This plugin **instructs** the agents and relies on Claude Code's normal permission prompts:

| | App | Plugin |
|---|---|---|
| Bash allowlist per role, no shell chaining | Enforced (`PreToolUse` hook + `canUseTool`) | Not enforced; roles are told what to run, and Claude Code asks you per your permission settings |
| File writes limited per role | Enforced | Instruction only; tool lists remove `Edit` from read-only roles |
| Push / branch / PR only after approval | Only the orchestrator code can | Only the main session is told to; it checks after each step that no subagent pushed or switched branch |
| Isolation for parallel features | Per-run git worktrees, port blocks, overlap warnings | Works in the current checkout; start the session in a separate worktree to run features in parallel |
| Fix-loop cap, cost budget, crash recovery | Enforced / automatic | Loop cap by instruction; `state.md` lets you resume a run |

If you need the guarantees, use the app; if you want something light to try in any repo, use the plugin.

## Maintaining

- The subagents' shared guidance comes from `prompts/shared/*.md`, the templates from `templates/`, and `skills/run/reference/stacks.md` from `backend/src/stacks.ts`. After editing any of those, run `npm run sync:prompts`. `npm run check:prompts` and a backend test fail if anything drifts.
- `npm run validate:plugin` runs `claude plugin validate` on the marketplace and plugin.
- Before publishing anywhere, add a LICENSE (the validator flags its absence).
