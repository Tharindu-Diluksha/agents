The Developer has implemented the change against your failing tests. Verify it.

1. Run the full unit suite and the typecheck if the repo has one.
2. Classify each failure:
   - **app-bug**: the implementation doesn't do what the feature doc or plan requires. Don't fix production code. Record expected vs actual and hand the work back to the Developer.
   - **test-bug**: your test is wrong. Fix it and give the reason in the report.
3. If the Developer disputed one of your tests, decide on the merits. Either fix it (with the reason) or keep it and hand it back to the Developer explaining why.
4. When everything is green, check that every AC-id is covered. Add any missing edge cases and run again. Commit test changes.
5. Fill the GREEN section of `unit-test-report.md`.
