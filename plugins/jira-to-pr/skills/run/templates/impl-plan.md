# Implementation plan: {{feature title}}

- **Ticket**: {{PROJ-123}}
- **ADR**: `runs/{{ticket}}/developer/adr.md`

## Pre-flight

- [ ] The unit test suite (`{{command}}`) is green on the base branch (verified by the Developer before planning).
- [ ] Target branch per repo: `{{feature/PROJ-123-...}}` (created off each repo's base branch).

## File plan

For each file: path, what changes, and why.

- `{{path/to/file.ts}}:{{line}}` — {{what, why}}.
- `{{path/to/file.ts}}` (new) — {{what, why}}.

## Test plan (TDD)

The Unit Tester writes these tests **before** you implement (they must fail first), then verifies them after. The Integration Tester covers the integration points. Reference the feature doc's acceptance-criteria IDs.

### Unit tests (written first, by the Unit Tester)

| AC-id | Test file | Behaviour under test |
| ----- | --------- | -------------------- |
| AC-1  | `{{path/to/foo.test.ts}}` | {{one sentence}} |

### Integration points (Integration Tester)

| AC-id | Boundary exercised | Happy path | Failure path(s) |
| ----- | ------------------ | ---------- | --------------- |
| AC-1  | {{e.g. POST /widgets → WidgetService → repo}} | {{...}} | {{...}} |

### End-to-end flows (E2E Tester, user-facing ACs only)

- AC-{{n}}: {{user flow}}

## Verification

How the user can confirm end-to-end once the Developer emits `done`:

- Run the unit and integration test suites in each affected repo — all green.
- {{manual UI step if applicable}}
- {{API call / log check if applicable}}
