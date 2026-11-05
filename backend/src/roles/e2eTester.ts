import type { RunRecord } from "../orchestrator/types.js";
import {  aiGuidelineSection,
  artifactRelative,
  BASH,
  endOfTurnExample,
  headerFor,
  maybeAttach,
  orchestratorSection,
  primaryRepo,
  TRACEABILITY_NOTE,
  stackSection
} from "./common.js";
import type { RoleSpec } from "./types.js";
import { workDir } from "../orchestrator/workspaces.js";

/** True once the user approved scaffolding an E2E suite for this run. */
export function suiteCreationApproved(record: RunRecord): boolean {
  return record.stateHistory.some((h) => h.from === "awaiting_test_suite_approval" && h.to === "e2e_tester_running");
}

export const e2eTester: RoleSpec = {
  id: "e2eTester",
  title: "E2E Tester",
  promptFile: "e2e-tester.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    BASH.gitRead,
    BASH.gitBranchRead,
    BASH.gitCommit,
    BASH.gitRestore,
    BASH.gitStash,
    BASH.ls,
  ],
  capabilities: ["test", "e2e", "inspect"],
  extraCapabilities(record) {
    // Installing packages is only permitted after the user approved suite creation.
    return suiteCreationApproved(record) ? ["install"] : [];
  },
  writeScope: "repos-and-run",
  needsWorkspace: true,
  maxTurns: 100,
  cwdFor(record) {
    return workDir(primaryRepo(record));
  },
  buildInput(record, ctx) {
    const reportPath = artifactRelative(record, "e2eTester", "e2e-test-report.md");
    const lines = [
      headerFor(record, "E2E Tester"),
      "## Scope",
      "",
      "Unit and integration tests are already green and the code has passed review. Your job is **end-to-end tests** that drive the real application the way a user would, one flow per acceptance criterion (the Stack section says which framework fits each repo).",
      "",
      "**Step 1.** Check each repo for an existing E2E suite (the Stack section says what one looks like for that stack). If the run spans multiple repos, the E2E suite usually lives in the UI repo; run tests there only.",
      "- If missing from the repo(s) that should have one: emit `status: \"awaiting_approval\"` with `approvalRequest.action: \"create_test_suite\"`. Describe exactly what you would scaffold (which repo, install step, directory layout, config). WAIT. Do not install anything yet. If the feature has no user-facing surface at all, say so in the summary — the user can skip E2E.",
      "- If present: proceed to step 2.",
      "",
      "**Step 2.** Write (or extend) end-to-end tests covering every user-facing acceptance criterion in the feature doc.",
      ...(record.ports
        ? [
            "",
            `**Ports.** Run the app under test on this run's ports (see the header and the Stack section). If the E2E config hard-codes a port or base URL, change it to read \`E2E_PORT\` / \`E2E_BASE_URL\` from the environment with the old value as the fallback, and make sure whatever starts the app uses that port. This is a test-infrastructure change you may make; mention it in the report.`,
          ]
        : []),
      "",
      "**Step 3.** Run the suite. Re-run a failing test once before classifying it, to rule out flakiness. For each failure, classify:",
      "- **test-bug**: the test itself is wrong (selector, timing, setup). Fix it inline, rerun.",
      "- **flaky**: passes on re-run without changes. Stabilise it (wait for the right condition, not a sleep) and note it in the report.",
      "- **app-bug**: the application behaviour disagrees with the feature doc. Do NOT fix the app. Record it in the report with repro steps, then emit `status: \"blocked\"` with `handoff.nextRole: \"developer\"`.",
      "",
      `**Step 4.** Commit the tests (do NOT push) and document test cases and results in \`${reportPath}\` using \`templates/e2e-test-report.md\`. On a fully green run, emit \`status: "done"\`; the orchestrator advances to the PR Creator.`,
      "",
      TRACEABILITY_NOTE,
      "",
      "You MUST NOT push. Installing packages or browsers is only allowed after the orchestrator passes `create_suite_approved`.",
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      maybeAttach(record, "integrationTester", "integration-test-report.md", "Integration test report"),
      stackSection(record, "e2eTester"),
      aiGuidelineSection(record, "e2eTester"),
      orchestratorSection(ctx),
      endOfTurnExample("example: no suite present", {
        status: "awaiting_approval",
        artifacts: [],
        approvalRequest: {
          action: "create_test_suite",
          summary: "No E2E suite found. Propose creating one.",
          payloadPaths: [],
        },
        handoff: null,
      }),
    ];
    return lines.join("\n");
  },
};
