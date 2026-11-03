# Feature: {{short title derived from the ticket}}

- **Ticket**: {{PROJ-123}} — {{ticket URL}}
- **Target repo**: {{repo path}}
- **Analyst**: Product Analyst role
- **Date**: {{today}}

## Problem

{{One paragraph: what user problem does this solve, who is affected, and what success looks like.}}

## Scope

**In scope**
- {{bullet}}

**Out of scope**
- {{bullet}}

## Acceptance criteria

Number every criterion. Downstream roles (Developer, Unit/Integration/E2E Testers, PR Creator) trace tests back to these IDs, so keep them stable across re-runs.

- [ ] **AC-1** — {{Given/When/Then or similar. Each must be testable.}} _(user-facing: yes/no)_
- [ ] **AC-2** — {{...}}

## Dependencies

- Upstream services: {{list, or "none"}}
- Feature flags: {{list, or "none"}}
- Data migrations: {{list, or "none"}}

## AI guideline alignment

{{If an AI guideline doc was provided (the orchestrator will tell you its path), cite the specific pages this feature must respect, with a one-line note on why each applies. Otherwise write "N/A for this run".}}

## Risks and edge cases

- {{bullet}}

## Open questions

- {{bullet with the questioner this is directed at — PM, backend, UX, security}}

## Non-goals

- {{bullet}}
