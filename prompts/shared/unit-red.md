No production code for this feature exists yet. Write unit tests from the approved plan's **Test plan** so they describe the required behaviour.

1. Locate the repo's unit test setup, starting from the plan's **Code map**. If there is none, stop and report blocked, saying what is missing.
2. Write the tests listed in the plan, plus obvious edge cases it misses.
3. Run them. Each new test must fail **for the right reason**: an assertion fails, or the module or function under test doesn't exist yet. It must not fail because of a typo or broken setup in the test itself. Tests that existed before must still pass. If the Stack section says a missing type or member breaks the build, add only the compile-only stubs it describes, so the new tests fail when they run, and list every stub in the report.
4. Commit the tests (for example `test: add failing unit tests for <feature>`).
5. Fill the RED section of `unit-test-report.md` (template `unit-test-report.md`).
