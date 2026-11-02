import {
  aiGuidelineSection,
  artifactRelative,
  BASH,
  endOfTurnExample,
  headerFor,
  maybeAttach,
  orchestratorSection,
  primaryRepo,
  TRACEABILITY_NOTE,
} from "./common.js";
import type { RoleSpec } from "./types.js";

/**
 * Unit Tester runs twice per implementation cycle:
 * - red phase (`unit_tests_red_running`): writes failing unit tests from the
 *   approved plan before any production code exists (TDD).
 * - green phase (`unit_tests_green_running`): after the Developer finishes,
 *   verifies those tests (and the rest of the unit suite) pass.
 * The same SDK session is resumed for both, so it remembers what it wrote.
 */
export const unitTester: RoleSpec = {
  id: "unitTester",
  title: "Unit Tester",
  promptFile: "unit-tester.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    BASH.gitRead,
    BASH.gitBranchRead,
    BASH.gitCommit,
    BASH.gitRestore,
    ...BASH.testRunners,
    BASH.catPackageJson,
    BASH.ls,
  ],
  writeScope: "repos-and-run",
  maxTurns: 80,
  cwdFor(record) {
    return primaryRepo(record).path;
  },
  buildInput(record, ctx) {
    const reportPath = artifactRelative(record, "unitTester", "unit-test-report.md");
    const red = record.state === "unit_tests_red_running";

    const lines = [headerFor(record, "Unit Tester"), `## Phase: ${red ? "RED — write failing tests" : "GREEN — verify the implementation"}`, ""];

    if (red) {
      lines.push(
        "No production code for this feature has been written yet. Write the unit tests listed in the plan's **Test plan** section (and any obvious edge cases it misses) so they describe the required behaviour.",
        "",
        "1. Find the repo's unit test setup (runner config, existing `*.test.ts` / `*.spec.ts` files, naming and folder conventions) and follow it. If the repo has no unit test runner at all, emit `status: \"blocked\"` explaining what is missing.",
        "2. Write the tests. Only create or edit test files (and test fixtures/helpers). Do NOT write production code — not even stubs.",
        "3. Run them and confirm each new test fails **for the right reason** (an assertion fails, or the module/export under test doesn't exist yet) — not because of a typo or broken setup in the test itself.",
        "4. Make sure tests that existed before still pass.",
        "5. Commit the new tests (e.g. `test: add failing unit tests for <feature>`). Do NOT push.",
        `6. Write \`${reportPath}\` using \`templates/unit-test-report.md\` (fill the RED section), then emit \`status: "done"\`. The orchestrator hands over to the Developer.`,
      );
    } else {
      lines.push(
        "The Developer has implemented the feature against your failing tests. Verify it.",
        "",
        "1. Run the full unit test suite (plus typecheck if the repo has one).",
        "2. If everything is green: check that every AC-id in the plan's test plan is covered. Add missing edge-case tests if you spot gaps, and run again.",
        "3. For each failure, classify it:",
        "   - **app-bug** — the implementation doesn't do what the feature doc / plan requires. Do NOT fix production code. Record expected vs actual in the report and emit `status: \"blocked\"` with `handoff.nextRole: \"developer\"`.",
        "   - **test-bug** — your test is wrong (it contradicts the feature doc or plan, or has a setup mistake). Fix it, and justify the change in the report. Never weaken an assertion just to make it pass.",
        "4. If the Developer handed a test back to you (see below), re-read the feature doc and plan, decide who is right, and either fix the test (justify it) or keep it and hand back to the Developer with your reasoning.",
        "5. Commit any test changes. Do NOT push.",
        `6. Update \`${reportPath}\` (fill the GREEN section). On a fully green suite emit \`status: "done"\`; the orchestrator advances to the Integration Tester.`,
      );
    }

    lines.push(
      "",
      TRACEABILITY_NOTE,
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "impl-plan.md", "Approved implementation plan"),
      red ? "" : maybeAttach(record, "unitTester", "unit-test-report.md", "Your unit test report so far"),
      "",
      "## Boundaries",
      "- Only test files, fixtures and test helpers. Never production code.",
      "- One Bash command at a time: git status/diff/log/show/add/commit/restore, npm/pnpm test*/typecheck*/lint*, npx vitest/jest/tsc, cat package.json, ls/dir.",
      "- You MUST NOT push.",
      aiGuidelineSection(record, "unitTester"),
      orchestratorSection(ctx),
      red
        ? endOfTurnExample("red phase done", { status: "done", artifacts: [reportPath], approvalRequest: null, handoff: null })
        : endOfTurnExample("green phase found an app-bug", {
            status: "blocked",
            artifacts: [reportPath],
            approvalRequest: null,
            handoff: { nextRole: "developer", notes: "2 unit tests fail due to application bugs; see unit-test-report.md." },
          }),
    );
    return lines.join("\n");
  },
};
