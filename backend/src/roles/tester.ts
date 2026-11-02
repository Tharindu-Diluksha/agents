import type { RoleSpec } from "./types.js";
import { artifactRelative, headerFor, maybeAttach, primaryRepo } from "./common.js";

export const tester: RoleSpec = {
  id: "tester",
  promptFile: "tester.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    /^git\s+(status|diff|log|show|add\b|commit\b|stash\b|rev-parse)/,
    /^npm\s+(install|run\s+\S+|test)(\s|$)/,
    /^npm\s+exec\s+playwright\s+/,
    /^npx\s+playwright\s+/,
    /^pnpm\s+(install|run\s+\S+|test|exec\s+playwright\s+)/,
    /^cat\s+(package\.json|playwright\.config\.(ts|js|mjs))$/,
    /^ls\b/,
    /^dir\b/,
  ],
  maxTurns: 100,
  cwdFor(record) {
    return primaryRepo(record).path;
  },
  buildInput(record, { feedback }) {
    const reportPath = artifactRelative(record, "tester", "test-report.md");
    const lines = [
      headerFor(record, "Tester"),
      "## Scope",
      "",
      "Your job is Playwright UI tests for the feature described below.",
      "",
      "**Step 1.** Check for an existing suite — look for `playwright.config.ts|js|mjs` in each repo listed above. If the run spans multiple repos, Playwright usually lives in the UI repo; run tests there only.",
      "- If missing from the repo(s) that should have one: emit `status: \"awaiting_approval\"` with `approvalRequest.action: \"create_test_suite\"`. Describe exactly what you would scaffold (which repo, install step, directory layout, config). WAIT. Do not install anything yet.",
      "- If present: proceed to step 2.",
      "",
      "**Step 2.** Write (or extend) tests covering the acceptance criteria from the feature doc. TDD if the feature code is already in — write tests that specifically exercise it.",
      "",
      "**Step 3.** Run the suite. For each failure, classify:",
      "- **test-bug**: the test itself is wrong (selector, timing, setup). Fix it inline, rerun.",
      "- **app-bug**: the application behaviour disagrees with the feature doc. Do NOT fix the app. Record it in the test report with repro steps, then emit `status: \"blocked\"` with `handoff.nextRole: \"developer\"` so the orchestrator sends it back for a fix.",
      "",
      `**Step 4.** Document test cases and results in \`${reportPath}\` using \`templates/test-report.md\`. On a fully-green run, emit \`status: "done"\` and the orchestrator will advance to PR Creator.`,
      "",
      "You MUST NOT push. You MAY install Playwright and its browsers only after the orchestrator passes `create_suite_approved`.",
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      "",
    ];
    if (feedback === "create_suite_approved") {
      lines.push("## Orchestrator signal", "", "The user APPROVED Playwright suite creation. Install Playwright, scaffold the config, add tests, and run them.");
    } else if (feedback) {
      lines.push("## Feedback", "", feedback);
    }
    lines.push(
      "",
      "## End-of-turn JSON block (example: no suite present)",
      "",
      "```json",
      JSON.stringify(
        {
          status: "awaiting_approval",
          artifacts: [],
          approvalRequest: {
            action: "create_test_suite",
            summary: "No Playwright suite found. Propose creating one.",
            payloadPaths: [],
          },
          handoff: null,
        },
        null,
        2,
      ),
      "```",
    );
    return lines.join("\n");
  },
};
