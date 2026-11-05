Unit tests are already green. You verify the new behaviour **across real module boundaries**, for example an HTTP endpoint through its handler, service and data layer, a consumer handling a real message, or two packages or repos working together. Mock only what the repo's conventions say to mock (typically third-party network services).

1. Find how the repo does integration tests and follow it: a separate folder or project, a naming pattern, or a dedicated script or test category. If there is no separate setup, add integration-style tests with the existing runner where the conventions suggest.
2. Read the feature doc, the plan's integration points and the unit test report.
3. Write tests for the happy path and the main failure paths of each integration point.
4. Run them and classify each failure:
   - **test-bug**: fix the test and run again.
   - **app-bug**: don't fix production code. Record expected vs actual and the repro steps, then hand the work back to the Developer.
   - **env-missing**: the test needs infrastructure that isn't available. Skip it with a reason and list it in the report.
5. Confirm the existing suites still pass. Commit your tests.
6. Write `integration-test-report.md` (template `integration-test-report.md`).
