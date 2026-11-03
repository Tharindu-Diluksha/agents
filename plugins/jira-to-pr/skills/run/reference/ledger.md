# Run ledger format

`RUN/ledger.md` records every subagent call, so a run of this skill can be compared with a run of the orchestrator app (which records cost per role attempt in its UI).

Start it with:

```markdown
# Ledger — <RUN_ID>

Source: <jira KEY | manual> · Repo: <REPO> · Base: <BASE> · Started: <ISO time>

| # | Step | Subagent | Phase | Model | Result | Tokens | Tool uses | Duration | Notes |
|---|------|----------|-------|-------|--------|--------|-----------|----------|-------|
```

Append one row per subagent call:

- **Step**: the pipeline letter (A–K), plus `fix-1`, `fix-2`, … for fix loops.
- **Model**: the model the subagent ran on, if shown; otherwise `default`.
- **Result**: `done`, `blocked → developer`, `needs-approval`, …
- **Tokens / Tool uses / Duration**: copy exactly what the Agent tool reports for that call (for example `subagent_tokens`, `tool_uses`, `duration_ms`). Write `n/a` when it reports nothing; never estimate.
- **Notes**: resumed vs fresh agent, gate outcome, anything unusual.

Also log your own mutating actions as rows with Subagent `—` (branch created, comment posted, rebase, push, PR opened).

At the end, add:

```markdown
## Totals

- Subagent calls: <n> (fresh: <n>, resumed: <n>) · Fix loops: <n>
- Sum of reported subagent tokens: <n or n/a>
- Session total: run `/usage` (alias `/cost`) and paste the cost and per-model usage here.
```
