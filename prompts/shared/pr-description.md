If the repo has a PR template (`.github/pull_request_template.md`, or one under `.github/` or `docs/`), follow its section headings. Otherwise use template `pr-description.md`. The first line is `# <title>`. Include:

- **Why**: 1–3 sentences from the feature doc.
- **Changes**: a short bullet summary of the diff.
- **Acceptance criteria → tests**: a table with one row per AC-id, listing the unit, integration and E2E tests that cover it (taken from the three test reports).
- **Test plan**: the commands a reviewer runs locally (from the Stack section), plus any manual checks.
- **Notes**: anything the reviewer must know, e.g. tests skipped as env-missing, or the branch rebased onto the base after the tests ran.
- **Link** to the ticket, if there is one.
