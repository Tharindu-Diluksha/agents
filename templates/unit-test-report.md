# Unit test report

- **Ticket**: {{PROJ-123}}
- **Tester**: Unit Tester role
- **Runner**: {{e.g. Vitest, Jest, xUnit, NUnit, pytest, go test}} — `{{command used}}`

## RED phase — failing tests written before implementation

| # | Test (file › name) | AC-id | Fails because | Notes |
| - | ------------------ | ----- | ------------- | ----- |
| 1 | `{{src/foo.test.ts › adds a widget}}` | AC-1 | {{assertion fails / export missing}} | {{...}} |

- Pre-existing tests: {{N}} passing (unchanged).
- Commit: `{{sha}}`

## GREEN phase — verification after implementation

- Result: {{N}} passed, {{N}} failed.
- Typecheck: {{pass / fail / n/a}}

### Failures (if any)

#### {{test name}}

- **Classification**: app-bug | test-bug
- **Expected**: {{...}}
- **Actual**: {{...}}
- **Action**: {{handed back to Developer / test fixed — justification: ...}}

### Tests added during verification

- {{edge case}} — AC-{{n}}

## Coverage by acceptance criterion

| AC-id | Tests | Status |
| ----- | ----- | ------ |
| AC-1  | {{n}} | green / red |
