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

The run's code changes happen in **`WORK`**: either the user's own checkout (branch mode) or an isolated git worktree of it (worktree mode). The user picks one in setup.

Request: **$ARGUMENTS**

## Keep your own context small

This session's context is shared by every step, so it gets more expensive as it grows.

- Never paste artifact contents into subagent messages — pass **paths**. Subagents read files themselves.
- Read only the `## Result` block of a subagent's final message. Open an artifact only when you need it for a gate summary or a decision, and read just what you need (e.g. `review-findings.json`, a report's summary section).
- Gate summaries are short (3–6 lines); the user can open the files.

## 1. Setup

1. **Repo.** `git rev-parse --show-toplevel` → `REPO`. Work only in this repo.
2. **Base branch.** `git symbolic-ref --short refs/remotes/origin/HEAD` (strip `origin/`), else `main`, else `master` → `BASE`. Confirm it at the plan gate.
3. **Source.** If `$ARGUMENTS` contains a JIRA key (`[A-Z][A-Z0-9]+-[0-9]+`, possibly inside an Atlassian URL) the source is **jira**; otherwise **manual**. If `$ARGUMENTS` is empty, ask the user for a ticket key or a description.
4. **Run folder.** `RUN_ID` = lower-case ticket key, or a short slug of the description, plus `-YYYYMMDD-HHMM`. `RUN` = `REPO/.jira-to-pr/RUN_ID`. Create it. Make sure `.jira-to-pr/` is listed in `REPO/.git/info/exclude` (append it if missing) so run files are never committed.
5. **Templates** are in `${CLAUDE_SKILL_DIR}/templates/` → `TEMPLATES`. Pass this absolute path to every subagent.
6. **Stack.** Read only the *Detecting the stack* section of `${CLAUDE_SKILL_DIR}/reference/stacks.md` and apply it to `REPO`, at the root and in each top-level folder (look at `package.json` dependencies, `angular.json`, `*.sln`/`*.csproj`, `pyproject.toml`/`requirements*.txt`, `go.mod`) → `STACK` (one or more of `typescript`, `node`, `vue`, `react`, `angular`, `dotnet`, `python`, `go`; for a monorepo name each stack's folder, e.g. `angular in prep-app/ + dotnet in prep-api/`). If nothing matches, ask the user which stack it is. `STACK_GUIDE` = the absolute path of that `stacks.md`. Confirm the stack at the plan gate.
7. **Workspace.** Ask the user where the run works (AskUserQuestion when available) → `WORKSPACE`:
   - **Isolated worktree** (recommended): a separate checkout of `REPO` for this run, with its own dependencies. The user's checkout is never touched, so they can keep working in it and run other features in parallel.
   - **New branch in this checkout**: the subagents work directly in `REPO`, and at Gate C you create the feature branch here. Uses the checkout's existing dependencies; the user shouldn't edit files here while the run is active.
8. **Prepare `WORK`.**
   - **Branch mode:** `WORK` = `REPO`. `git status --porcelain --untracked-files=no` must be empty, and `git branch --show-current` must be `BASE` (the plan is made against what is checked out). If not, show it and ask the user to commit/stash or switch first (or to choose a worktree instead); stop until they confirm.
   - **Worktree mode:** `WORK` = `RUN/worktree`. `git fetch origin <BASE>` (skip if there is no `origin`), then `git worktree add --detach "<WORK>" origin/<BASE>` (or `<BASE>` when there is no remote). Install its dependencies in each stack folder of `WORK` (`cd "<WORK>/<folder>" && …`): Node — `npm ci` with a `package-lock.json` (`pnpm install --frozen-lockfile` / `yarn install --frozen-lockfile` with their lockfiles, else `npm install`); .NET — `dotnet restore`; Python — `uv sync` / `poetry install` when locked, else `python -m venv .venv` and `.venv`'s pip `install -r` each `requirements*.txt`; Go — `go mod download`. If an install fails, show the error and ask how to proceed. If the tests need local files that aren't committed (e.g. `.env.test`), ask before copying them from `REPO`. The worktree lives under the excluded `.jira-to-pr/` folder; if a test runner started at `REPO`'s root also picks up files there, tell the user it can be added to that runner's ignore list.
9. Create `RUN/state.md` (see *State and resuming*) and `RUN/ledger.md` (see `${CLAUDE_SKILL_DIR}/reference/ledger.md`).

## 2. Load the source → `RUN/ticket.md`

- **jira:** use the JIRA / Atlassian MCP tools available in this session (a "get issue" tool) to fetch the issue. Write `ticket.md` with key, URL, summary, description, acceptance criteria, labels, linked issues and recent comments. If no JIRA tool is available, tell the user and ask them to paste the ticket (then treat it as manual) or connect their Atlassian MCP server and re-run.
- **manual:** write the user's description to `ticket.md` verbatim (title, description, acceptance criteria if given).

## 3. Calling subagents

Subagents (from this plugin): `jira-to-pr:analyst`, `jira-to-pr:developer`, `jira-to-pr:unit-tester`, `jira-to-pr:integration-tester`, `jira-to-pr:reviewer`, `jira-to-pr:e2e-tester`, `jira-to-pr:pr-writer`. If your agent list shows them without the `jira-to-pr:` prefix, use the bare names.

Every task message contains, as a short list:

```
Phase: <PLAN | IMPLEMENT | FIX | MERGE-CONFLICTS | RED | GREEN | — >
Repo: <WORK>
Base: <BASE or base ref to diff against>
Run folder: <RUN>
Templates: <TEMPLATES>
Stack: <STACK, e.g. "python", "react + go" or "angular in prep-app/ + dotnet in prep-api/">
Stack guide: <STACK_GUIDE>
Source: <jira KEY URL | manual>
Read: <paths of the artifacts/reports this step needs>
Notes / feedback: <user feedback from the last gate, hand-back notes, orchestrator notes — or "none">
```

In **worktree mode** add one more line: `Working copy: <WORK> is an isolated worktree for this run. Run every command from it (cd "<WORK>" && …, or cd into a stack folder under it) and edit only files under it; <REPO> is the user's own checkout — don't touch it.` Subagents start in the session's folder (`REPO`), so without this they would work in the wrong checkout.

**Same role again in this run** (developer PLAN → IMPLEMENT → FIX, unit-tester RED → GREEN, a role re-run after "request changes"): if you can resume that role's earlier subagent (e.g. `SendMessage` to its agent id), do that and send only the new phase and inputs — it keeps its memory of the earlier step. Otherwise start a fresh one; the artifacts carry the context.

After **every** subagent call:
1. Parse its `## Result` block. If it is missing, ask that subagent once for it; if still missing, treat the step as blocked.
2. Append a ledger row (tokens / tool uses / duration exactly as the Agent tool reports them, or `n/a`).
3. Update `state.md`.
4. Check it stayed in bounds: `git -C "<WORK>" branch --show-current` is still the run's branch (once created) and nothing was pushed (`git -C "<WORK>" status -sb` shows no new upstream). In worktree mode also check that `REPO` itself didn't change (`git -C "<REPO>" status --porcelain --untracked-files=no` is as it was at setup). If a subagent switched branches, pushed, opened a PR or edited the user's checkout, **stop** and tell the user.

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

- **Gate A — feature doc:** if `open_questions` > 0, list the questions and ask the user to answer them; **Approve is not an option until every open question is answered** (re-run the analyst with the answers; repeat until `open_questions: 0`). Options while questions remain: Answer (Other — the user types the answers) · Post the questions to JIRA (jira source only, when `proposed-jira-comment.md` exists — for questions the user can't answer) · Stop. To post, use the JIRA MCP add-comment tool with the file's text (or the user's edit); if posting fails, show the error and ask again. Posting does not pass the gate: the run waits for the answers (the user can come back later; when they say the answers are on the ticket, re-fetch it into `ticket.md` and re-run the analyst). With no open questions: Approve · Request changes (re-run analyst with the feedback) · Stop.
- **Gate B — plan:** show the plan's file list and test plan in brief, the base branch and the detected stack. Approve · Request changes (re-run developer PLAN with feedback) · Change base or stack · Stop.
- **Gate C — branch:** propose `feature/<ticket-key-or-slug>-<short-slug>` (lower-case, `[a-z0-9/-]`). If `git branch --list <name>` or `git worktree list` shows it in use, add a suffix. Approve · Use another name (Other) · Stop. Then, in `WORK`: `git -C "<WORK>" fetch origin <BASE>` (if there is an `origin`), and `git -C "<WORK>" switch -c <name> origin/<BASE>` (or `<BASE>` when there is no remote). In worktree mode this turns the detached worktree into the feature branch; the user's checkout stays on its own branch.
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

Run every git command in J and L inside `WORK` (`git -C "<WORK>" …`, and `gh` from `WORK`).

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
workspace: <branch | worktree>   work: <WORK>
branch: <name or —>   step: <A..L>   status: <running | waiting-gate X | blocked | done>
fix_loops: <n>
agents: analyst=<agent id>, developer=<agent id>, unit-tester=<agent id>, …
history:
- <time> A analyst done → Gate A approved
- …
```

If the user re-runs `/jira-to-pr:run` while an unfinished run folder exists for the same ticket/slug, offer to **resume** it from `state.md` (subagent ids from an earlier session may no longer resume — start fresh ones, the artifacts carry the context). In worktree mode reuse `WORK` from `state.md`; if it no longer exists, re-create it with `git worktree add "<WORK>" <branch>` (or detached at the base before Gate C) and reinstall its dependencies.

## 6. Finish

When the PR is open (or the user stops):

1. Finalise `ledger.md` (totals row).
2. **Worktree mode:** ask whether to remove the worktree (the branch and the PR stay). If yes: `git worktree remove "<WORK>"`; if git refuses because of uncommitted files, show them and ask before using `--force`.
3. Tell the user: the PR URL, the fix-loop count, the run folder, and that **`/usage`** (alias `/cost`) shows this session's total cost and usage, including the subagents. For a cost comparison with the orchestrator app, see the plugin README.

## Boundaries

- Only you push, open the PR, switch/create branches, rebase/merge with the base, or post to JIRA — and only after the matching gate.
- Never force-push. Never edit files yourself to "help" a subagent; send it back with feedback instead.
- Never store secrets in the run folder. Never commit the run folder.
- In worktree mode the user's checkout (`REPO`) is read-only for the whole run: only `RUN` and `WORK` change.
