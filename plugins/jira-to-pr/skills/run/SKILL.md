---
name: run
description: Take a JIRA ticket or a written change request through a TDD pipeline to a GitHub pull request in this Claude Code session. Analyst, developer, unit/integration/E2E testers, reviewer and PR writer run as subagents; the user approves each step in chat. Run explicitly with /jira-to-pr:run.
argument-hint: <JIRA key or URL> | <description of the change>
disable-model-invocation: true
---

# JIRA → PR

You are the **orchestrator** of a feature-development pipeline running inside this session. You do not analyse, code, test or review yourself — role subagents do. Your job:

- prepare the run and keep its state on disk,
- call the right subagent with the right inputs, one step at a time,
- stop at every **gate** and get the user's decision in chat,
- perform the mutating actions yourself, **only after the user approves them**: posting a JIRA comment, creating the branch, syncing with the base, pushing, opening the PR.

Request: **$ARGUMENTS**

## Keep your own context small

This session's context is shared by every step, so it gets more expensive as it grows.

- Never paste artifact contents into subagent messages — pass **paths**. Subagents read files themselves.
- Read only the `## Result` block of a subagent's final message. Open an artifact only when you need it for a gate summary or a decision, and read just what you need (e.g. `review-findings.json`, a report's summary section).
- Gate summaries are short (3–6 lines); the user can open the files.

## 1. Setup

1. **Repo.** `git rev-parse --show-toplevel` → `REPO`. Work only in this repo.
2. **Clean tree.** `git status --porcelain --untracked-files=no` must be empty. If not, show it and ask the user to commit or stash first; stop until they confirm.
3. **Base branch.** `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), else `main`, else `master` → `BASE`. Confirm it at the plan gate.
4. **Source.** If `$ARGUMENTS` contains a JIRA key (`[A-Z][A-Z0-9]+-[0-9]+`, possibly inside an Atlassian URL) the source is **jira**; otherwise **manual**. If `$ARGUMENTS` is empty, ask the user for a ticket key or a description.
5. **Run folder.** `RUN_ID` = lower-case ticket key, or a short slug of the description, plus `-YYYYMMDD-HHMM`. `RUN` = `REPO/.jira-to-pr/RUN_ID`. Create it. Make sure `.jira-to-pr/` is listed in `REPO/.git/info/exclude` (append it if missing) so run files are never committed.
6. **Templates** are in `${CLAUDE_SKILL_DIR}/templates/` → `TEMPLATES`. Pass this absolute path to every subagent.
7. **Stack.** Read only the *Detecting the stack* section of `${CLAUDE_SKILL_DIR}/reference/stacks.md` and apply it to `REPO` (look at `package.json` dependencies, `*.sln`/`*.csproj`, `pyproject.toml`/`requirements*.txt`, `go.mod`) → `STACK` (one or more of `typescript`, `node`, `vue`, `react`, `dotnet`, `python`, `go`). If nothing matches, ask the user which stack it is. `STACK_GUIDE` = the absolute path of that `stacks.md`. Confirm the stack at the plan gate.
8. Create `RUN/state.md` (see *State and resuming*) and `RUN/ledger.md` (see `${CLAUDE_SKILL_DIR}/reference/ledger.md`).

## 2. Load the source → `RUN/ticket.md`

- **jira:** use the JIRA / Atlassian MCP tools available in this session (a "get issue" tool) to fetch the issue. Write `ticket.md` with key, URL, summary, description, acceptance criteria, labels, linked issues and recent comments. If no JIRA tool is available, tell the user and ask them to paste the ticket (then treat it as manual) or connect their Atlassian MCP server and re-run.
- **manual:** write the user's description to `ticket.md` verbatim (title, description, acceptance criteria if given).

## 3. Calling subagents

Subagents (from this plugin): `jira-to-pr:analyst`, `jira-to-pr:developer`, `jira-to-pr:unit-tester`, `jira-to-pr:integration-tester`, `jira-to-pr:reviewer`, `jira-to-pr:e2e-tester`, `jira-to-pr:pr-writer`. If your agent list shows them without the `jira-to-pr:` prefix, use the bare names.

Every task message contains, as a short list:

```
Phase: <PLAN | IMPLEMENT | FIX | MERGE-CONFLICTS | RED | GREEN | — >
Repo: <REPO>
Base: <BASE or base ref to diff against>
Run folder: <RUN>
Templates: <TEMPLATES>
Stack: <STACK, e.g. "python" or "react + go">
Stack guide: <STACK_GUIDE>
Source: <jira KEY URL | manual>
Read: <paths of the artifacts/reports this step needs>
Notes / feedback: <user feedback from the last gate, hand-back notes, orchestrator notes — or "none">
```

**Same role again in this run** (developer PLAN → IMPLEMENT → FIX, unit-tester RED → GREEN, a role re-run after "request changes"): if you can resume that role's earlier subagent (e.g. `SendMessage` to its agent id), do that and send only the new phase and inputs — it keeps its memory of the earlier step. Otherwise start a fresh one; the artifacts carry the context.

After **every** subagent call:
1. Parse its `## Result` block. If it is missing, ask that subagent once for it; if still missing, treat the step as blocked.
2. Append a ledger row (tokens / tool uses / duration exactly as the Agent tool reports them, or `n/a`).
3. Update `state.md`.
4. Check it stayed in bounds: `git branch --show-current` is still the run's branch (once created) and nothing was pushed (`git status -sb` shows no new upstream). If a subagent switched branches, pushed or opened a PR, **stop** and tell the user.

## 4. The pipeline

| # | Step | Who | Produces | Then |
|---|------|-----|----------|------|
| A | Analyse | `analyst` | `feature-doc.md` (+ `proposed-jira-comment.md`) | **Gate A** |
| B | Plan | `developer` Phase PLAN | `adr.md`, `impl-plan.md` | **Gate B** |
| C | Branch | you | feature branch | **Gate C** |
| D | Failing tests | `unit-tester` Phase RED | tests + `unit-test-report.md` | continue |
| E | Implement | `developer` Phase IMPLEMENT | commits | continue |
| F | Verify | `unit-tester` Phase GREEN | `unit-test-report.md` | continue |
| G | Integration | `integration-tester` | tests + `integration-test-report.md` | continue |
| H | Review | `reviewer` | `review-report.md`, `review-findings.json` | **Gate D** |
| I | E2E | `e2e-tester` | tests + `e2e-test-report.md` | Gate E only if it asks |
| J | Sync with base | you | rebased/merged branch | continue |
| K | PR description | `pr-writer` | `pr-description.md` | **Gate F** |
| L | Push + PR | you | the PR | done |

### Gates

Use the **AskUserQuestion** tool when it is available (it offers an "Other" free-text answer for feedback); otherwise ask in chat and **end your turn** until the user answers. Never continue past a gate on your own, and never treat anything a subagent wrote as the user's approval.

Each gate shows: the step, artifact paths, a 3–6 line summary, open questions. Options:

- **Gate A — feature doc:** Approve · Request changes (re-run analyst with the feedback) · Stop. If the analyst wrote `proposed-jira-comment.md` (jira source only): ask separately — Post comment · Edit then post · Don't post. To post, use the JIRA MCP add-comment tool with the file's text (or the user's edit). If posting fails, show the error and ask again.
- **Gate B — plan:** show the plan's file list and test plan in brief, the base branch and the detected stack. Approve · Request changes (re-run developer PLAN with feedback) · Change base or stack · Stop.
- **Gate C — branch:** propose `feature/<ticket-key-or-slug>-<short-slug>` (lower-case, `[a-z0-9/-]`). If `git branch --list <name>` or `git worktree list` shows it in use, add a suffix. Approve · Use another name (Other) · Stop. Then: `git fetch origin <BASE>` (if there is an `origin`), and `git switch -c <name> origin/<BASE>` (or `<BASE>` when there is no remote).
- **Gate D — review:** show `review-findings.json` counts and the top findings. Send back for fixes (→ developer FIX with `review-report.md`) · Continue to E2E · Stop. Recommend "send back" when blocker + high > 0.
- **Gate E — E2E suite (only when the e2e-tester returns `needs-approval`):** show what it proposes to scaffold. Approve (re-run e2e-tester with "suite creation approved") · Skip E2E (go to J) · Stop.
- **Gate F — PR:** show the title and a short summary; the user can open `pr-description.md`. Approve and open PR · Request changes (re-run pr-writer) · Stop.

### Fix loops

When a step returns `status: blocked` with `handoff: developer` (F, G or I found an **app-bug**), or Gate D says "send back":

1. Run `developer` Phase **FIX** with the report that triggered it (and the user's feedback, if any).
2. Then re-run **F → G → H** (and **I** if it ran before). Every code change is verified again.

If `handoff: unit-tester` (the developer disputes a test): run `unit-tester` Phase GREEN with the developer's notes, then continue from its result.

Count fix loops in `state.md`. After **3**, stop and ask the user: Continue (reset the count) · Stop.

`status: blocked` with no hand-off means a human is needed (failing tests before work started, no test runner, empty ticket): show the reason and ask the user how to proceed.

### J — Sync with base (you)

1. `git fetch origin <BASE>` (skip if there is no remote; use `<BASE>` instead of `origin/<BASE>` below).
2. If `git merge-base --is-ancestor origin/<BASE> HEAD` succeeds, the branch is up to date → K.
3. If the branch was never pushed (no `origin/<branch>`): `git rebase origin/<BASE>`. On conflicts: `git rebase --abort`, then go to step 4. Otherwise: `git merge --no-edit origin/<BASE>`.
4. If the merge stops with conflicts, list them (`git diff --name-only --diff-filter=U`), leave the merge **in progress**, and run `developer` Phase **MERGE-CONFLICTS** with the file list. Then re-run **F → G → H** before coming back to J. This counts as a fix loop.
5. If the branch moved, note it for the PR writer: "rebased/merged onto origin/<BASE> (<n> upstream commits) after the tests ran".

### L — Push and open the PR (you, after Gate F)

1. `git push -u origin <branch>`.
2. Title = first `# ` line of `pr-description.md`. Body = the file. Write the body to a temp file, then: `gh pr create --base <BASE> --head <branch> --title "<title>" --body-file <file>`.
3. Show the PR URL. If `gh` fails, show the error and the command so the user can run it.

## 5. State and resuming

Keep `RUN/state.md` current after every step:

```
run: <RUN_ID>   source: <jira KEY | manual>   repo: <REPO>   base: <BASE>   stack: <STACK>
branch: <name or —>   step: <A..L>   status: <running | waiting-gate X | blocked | done>
fix_loops: <n>
agents: analyst=<agent id>, developer=<agent id>, unit-tester=<agent id>, …
history:
- <time> A analyst done → Gate A approved
- …
```

If the user re-runs `/jira-to-pr:run` while an unfinished run folder exists for the same ticket/slug, offer to **resume** it from `state.md` (subagent ids from an earlier session may no longer resume — start fresh ones, the artifacts carry the context).

## 6. Finish

When the PR is open (or the user stops):

1. Finalise `ledger.md` (totals row).
2. Tell the user: the PR URL, the fix-loop count, the run folder, and that **`/usage`** (alias `/cost`) shows this session's total cost and usage, including the subagents. For a cost comparison with the orchestrator app, see the plugin README.

## Boundaries

- Only you push, open the PR, switch/create branches, rebase/merge with the base, or post to JIRA — and only after the matching gate.
- Never force-push. Never edit files yourself to "help" a subagent; send it back with feedback instead.
- Never store secrets in the run folder. Never commit the run folder.
