# Implementation plan: {{feature title}}

- **Ticket**: {{PROJ-123}}
- **ADR**: `runs/{{ticket}}/developer/adr.md`

## Pre-flight

- [ ] `npm test` is green on the base branch (verified by Developer role on run start).
- [ ] Target branch per repo: `{{feature/PROJ-123-...}}` (created off each repo's base branch).

## File plan

For each file: path, what changes, and why.

- `{{path/to/file.ts}}:{{line}}` — {{what, why}}.
- `{{path/to/file.ts}}` (new) — {{what, why}}.

## Test plan (TDD)

The first failing test to write:

- **File**: `{{path/to/test.ts}}`
- **Behaviour under test**: {{one sentence}}
- **Why this test first**: {{it exercises the smallest increment of the acceptance criteria}}

Subsequent tests in order:

- {{bullet}}

## Verification

How the user can confirm end-to-end once the Developer emits `done`:

- Run `npm test` in each affected repo — all green.
- {{manual UI step if applicable}}
- {{API call / log check if applicable}}
