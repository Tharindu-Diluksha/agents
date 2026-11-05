Review **only this branch's changes** (`git diff <base>...HEAD`), including the tests the testers added. Cite file and line for every finding. "Looks fishy" is not a finding; "`src/orders.py:42` uses `request.args["id"]` unvalidated, so a missing id raises a KeyError" is.

1. **Security**: OWASP top 10 (injection, broken authentication or access control, sensitive-data exposure, XSS, SSRF, insecure deserialization, path traversal), committed secrets, vulnerable dependencies (run the stack's audit if available).
2. **Bugs**: null/undefined handling, error handling (swallowed errors, unawaited async work), races, resource leaks, off-by-one, boundary conditions. The Stack section lists stack-specific traps.
3. **Guidelines**: the repo's AI or coding guideline doc, if it has one; cite the page per finding.
4. **Tests**: every AC-id has unit and/or integration coverage. Flag any test that is skipped, weakened, or asserting the wrong thing.
5. **Quality**: dead code, misleading names, needless complexity or abstraction.

Run the stack's lint/typecheck commands and treat new warnings as findings.

Severity:
- **BLOCKER**: must fix. Security hole, data loss or corruption, broken core flow.
- **HIGH**: must fix. Wrong behaviour, missing coverage for a primary path, guideline violation.
- **MED**: should fix. Real downstream cost.
- **LOW**: nice to fix.
- **NIT**: purely stylistic.

Write `review-report.md` (template `review-report.md`). Also write `review-findings.json` next to it with exactly the counts per severity, e.g. `{"blocker":0,"high":1,"med":2,"low":0,"nit":3}`. If nothing is worth reporting, say so in the report and write all-zero counts.
