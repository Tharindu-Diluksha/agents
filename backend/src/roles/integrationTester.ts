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
import { workDir } from "../orchestrator/workspaces.js";

export const integrationTester: RoleSpec = {
  id: "integrationTester",
  title: "Integration Tester",
  promptFile: "integration-tester.md",
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
  needsWorkspace: true,
  maxTurns: 80,
  cwdFor(record) {
    return workDir(primaryRepo(record));
  },
  buildInput(record, ctx) {
    const reportPath = artifactRelative(record, "integrationTester", "integration-test-report.md");
    const lines = [
      headerFor(record, "Integration Tester"),
      "## Scope",
      "",
      "Unit tests are already green. Your job is **integration tests**: exercise the new behaviour across real module boundaries — e.g. HTTP route → handler → service → repository, a job consuming a real message shape, or two packages working together — with as little mocking as the repo's conventions allow.",
      "",
      "1. Discover how the repo does integration tests (an `integration/` folder, `*.int.test.ts`, a separate Vitest project/config, a `test:integration` script). Follow that. If there is no separate setup, add integration-style tests using the existing runner, in the location the repo's conventions suggest.",
      "2. Write tests for the integration points listed in the plan's **Test plan** section, covering the happy path and the main failure paths for each relevant AC-id.",
      "3. Run them. For each failure classify:",
      "   - **test-bug** — fix the test, rerun.",
      "   - **app-bug** — do NOT fix production code. Record expected vs actual and repro in the report, then emit `status: \"blocked\"` with `handoff.nextRole: \"developer\"`.",
      "   - **env-missing** — the test needs infrastructure that is not available here (database, external service, credentials). Do not fake it. Mark those tests as skipped with a clear reason, and list them in the report so the user can run them elsewhere.",
      "4. Make sure the existing test suites still pass. Commit your tests. Do NOT push.",
      `5. Write \`${reportPath}\` using \`templates/integration-test-report.md\`. When nothing is classified app-bug, emit \`status: "done"\`; the orchestrator advances to the Reviewer.`,
      "",
      TRACEABILITY_NOTE,
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      maybeAttach(record, "unitTester", "unit-test-report.md", "Unit test report"),
      maybeAttach(record, "integrationTester", "integration-test-report.md", "Your previous integration test report (if re-run)"),
      "",
      "## Boundaries",
      "- Only test files, fixtures and test helpers. Never production code.",
      "- One Bash command at a time: git status/diff/log/show/add/commit/restore, npm/pnpm test*/typecheck*/lint*, npx vitest/jest/tsc, cat package.json, ls/dir.",
      "- You MUST NOT push.",
      aiGuidelineSection(record, "integrationTester"),
      orchestratorSection(ctx),
      endOfTurnExample("all integration tests pass", {
        status: "done",
        artifacts: [reportPath],
        approvalRequest: null,
        handoff: null,
      }),
    ];
    return lines.join("\n");
  },
};
