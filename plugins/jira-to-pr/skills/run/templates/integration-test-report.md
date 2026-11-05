# Integration test report

- **Ticket**: {{PROJ-123}}
- **Tester**: Integration Tester role
- **Runner / setup**: {{e.g. vitest project "integration", `npm run test:integration`}}

## Test cases

| # | Test (file › name) | AC-id | Boundary exercised | Result | Notes |
| - | ------------------ | ----- | ------------------ | ------ | ----- |
| 1 | `{{tests/integration/widgets.int.test.ts › creates a widget}}` | AC-1 | {{POST /widgets → service → repo}} | pass / fail / skipped | {{...}} |

## Failures (if any)

### {{test name}}

- **Classification**: test-bug | app-bug | env-missing
- **Expected**: {{...}}
- **Actual**: {{...}}
- **Repro**: {{steps}}
- **Action**: {{fixed test / handed back to Developer / skipped — needs: ...}}

## Not runnable here (env-missing)

- {{test}} — needs {{database / service / credential}}. Run with: `{{command}}`.

## Final status

- {{N}} passed, {{N}} failed, {{N}} skipped.
- Existing suites still green: {{yes/no}}.
