# E2E test report

- **Ticket**: {{PROJ-123}}
- **Tester**: E2E Tester role
- **Suite**: Playwright
- **Config**: `{{playwright.config.ts}}`
- **Run at**: {{timestamp}}

## Setup

- Playwright version: {{...}}
- Browsers run: {{chromium, firefox, webkit}}
- Setup commands run: {{...}}

## Test cases

| # | Name | AC-id | Result | Duration | Notes |
| - | ---- | -------------------- | ------ | -------- | ----- |
| 1 | {{name}} | AC-1 | pass / fail | {{ms}} | {{...}} |

## Failures (if any)

### Failure 1 — {{test name}}

- **Classification**: test-bug | flaky | app-bug
- **Expected**: {{...}}
- **Actual**: {{...}}
- **Repro**: {{steps}}
- **Fix applied** (if test-bug): {{...}}
- **Handoff** (if app-bug): back to Developer; see expected-vs-actual above.

## Final status

- {{N}} tests passed, {{N}} failed.
- {{"All green" | "Handoff to Developer required"}}
