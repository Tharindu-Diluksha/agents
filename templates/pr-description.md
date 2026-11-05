# {{PROJ-123}}: {{short title}}

## Summary

{{1–3 sentences: why this change exists (from the feature doc).}}

## Changes

- {{bullet}}
- {{bullet}}

## Acceptance criteria → tests

| AC-id | Unit | Integration | E2E |
| ----- | ---- | ----------- | --- |
| AC-1  | `{{foo.test.ts > ...}}` | `{{widgets.int.test.ts > ...}}` | `{{widget.spec.ts > ...}}` |

## Test plan

- [ ] Unit tests (`{{command}}`) — green.
- [ ] Integration tests — green ({{note any tests skipped as env-missing}}).
- [ ] E2E tests (`{{command}}`) — green, or N/A.
- [ ] {{manual verification step}}.

## Related

- JIRA: {{ticket URL}}
- ADR: `runs/{{ticket}}/developer/adr.md`
- Impl plan: `runs/{{ticket}}/developer/impl-plan.md`

