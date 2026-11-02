# Code review report

- **Ticket**: {{PROJ-123}}
- **Reviewer**: Code Reviewer role
- **Date**: {{today}}
- **Scope reviewed**: `{{baseBranch}}..HEAD` for each repo in the run

## Summary

{{One or two sentences on the overall shape and major themes.}}

## Findings

### BLOCKER

- **{{path/to/file.ts}}:{{line}}** — {{description}}.
  - **Fix**: {{specific instruction, not vague advice}}.

### HIGH

- **{{path/to/file.ts}}:{{line}}** — {{description}}.
  - **Fix**: {{...}}.

### MED

- **{{path/to/file.ts}}:{{line}}** — {{description}}.
  - **Fix**: {{...}}.

### LOW

- {{...}}

### NIT

- {{...}}

## Test coverage

| AC-id | Unit | Integration | Notes |
| ----- | ---- | ----------- | ----- |
| AC-1  | {{yes/no}} | {{yes/no}} | {{gaps, weakened or skipped tests}} |

## AI guideline alignment

- {{cite ai-guideline page, state whether aligned (omit this section if no ai-guideline doc was configured)}}

## No findings

{{If there were no issues worth reporting, state that here and delete the sections above.}}

## Machine-readable counts

Also write `review-findings.json` next to this report, e.g. `{"blocker":0,"high":1,"med":2,"low":0,"nit":3}`.
