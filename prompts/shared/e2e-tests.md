Write end-to-end tests that drive the **running application** the way a user would: one flow per user-facing acceptance criterion, with the AC-id in the test title. Unit and integration behaviour is already covered, so prefer whole user flows. Use stable selectors (`data-testid`, roles or labels). The Stack section says which E2E framework fits each repo and how the app takes its port.

Run the suite. Re-run a failing test once before classifying it:
- **test-bug**: the test is wrong (selector, timing, setup, assertion). Fix it and run again.
- **flaky**: it passes on re-run without changes. Stabilise it by waiting for the right condition, never a fixed sleep, and note it in the report.
- **app-bug**: the application disagrees with the feature doc. Don't fix the app. Record expected vs actual and the repro steps, then hand the work back to the Developer.

If the E2E config hard-codes a port or base URL, make it read `E2E_PORT` / `E2E_BASE_URL` from the environment, keeping the old value as fallback, and mention that in the report.

Commit the tests. Write `e2e-test-report.md` (template `e2e-test-report.md`): for every test case give the description, AC-id, result, duration and any failure classification.
