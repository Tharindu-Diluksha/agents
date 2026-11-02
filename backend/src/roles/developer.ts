import { aiGuidelineSection, artifactRelative, headerFor, maybeAttach, primaryRepo } from "./common.js";
import type { RoleSpec } from "./types.js";

export const developer: RoleSpec = {
  id: "developer",
  promptFile: "developer.md",
  allowedTools: [
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "Bash",
    "mcp__atlassian-local__getJiraIssue",
  ],
  bashAllowList: [
    /^git\s+(status|diff|log|show|branch(\s|$)|rev-parse|checkout\s+-b\s+\S+$|checkout\s+\S+$|add\b|commit\b|stash\b|fetch\b|pull\s+--rebase\b)/,
    /^npm\s+(test|run\s+(test|typecheck|lint|build|dev|typecheck:watch))(\s|$)/,
    /^npx\s+(vitest|tsc)(\s|$)/,
    /^pnpm\s+(test|run\s+(test|typecheck|lint|build))(\s|$)/,
    /^node\s+(--version|-v)$/,
    /^cat\s+package\.json$/,
    /^ls\b/,
    /^dir\b/,
  ],
  maxTurns: 100,
  cwdFor(record) {
    return primaryRepo(record).path;
  },
  buildInput(record, { feedback }) {
    const adrPath = artifactRelative(record, "developer", "adr.md");
    const planPath = artifactRelative(record, "developer", "impl-plan.md");

    const lines = [
      headerFor(record, "Developer"),
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc (from Analyst)"),
      maybeAttach(record, "reviewer", "review-report.md", "Code review report (if present — address every HIGH/MED finding)"),
      maybeAttach(record, "tester", "test-report.md", "Test report (if present — fix every failure classified as app-bug)"),
      "",
      "## Your workflow",
      "",
      "**Phase 1 — Planning (if ADR + impl plan not yet written).**",
      "1. Confirm existing tests pass: run `npm test` in the target repo. If anything is red before you touch the code, emit `status: \"blocked\"` with a terminal JSON block describing which tests failed. Do NOT proceed.",
      `2. Write an ADR to \`${adrPath}\` using \`templates/adr.md\`.`,
      `3. Write an implementation plan to \`${planPath}\` using \`templates/impl-plan.md\`. The plan should list every file to touch and the test(s) you will add first (TDD).`,
      "4. End your turn with `approvalRequest.action: \"proceed_to_next\"` so the user can approve the plan.",
      "",
      "**Phase 2 — Implementation (only after the orchestrator passes `plan_approved` or feedback requiring fixes).**",
      "1. Follow the plan. TDD: write a failing test, make it pass, keep the suite green.",
      "2. Commit incrementally with meaningful messages. DO NOT push.",
      "3. When done, run the full test suite once more and emit `status: \"done\"`. The orchestrator will auto-advance to the Reviewer.",
      "",
      "Boundaries:",
      "- You MUST NOT push to any remote. The PR Creator role handles pushes.",
      "- Bash commands outside the allowlist (git, npm/pnpm test/typecheck/lint/build, npx vitest/tsc, cat package.json, ls/dir) will be blocked.",
      "- Do not edit files outside the target repo.",
      aiGuidelineSection(record, "developer"),
    ];

    if (feedback === "plan_approved") {
      lines.push("", "## Orchestrator signal", "", "The user has APPROVED your plan. Proceed with implementation now.");
    } else if (feedback === "review_report_attached") {
      lines.push("", "## Orchestrator signal", "", "The user requires fixes based on the review report attached above. Address every HIGH/MED finding, then re-run the test suite.");
    } else if (feedback === "handoff_from_tester") {
      lines.push("", "## Orchestrator signal", "", "The Tester classified a failure as an application bug. Fix it based on the test report above and re-run the suite.");
    } else if (feedback && feedback.length > 0) {
      lines.push("", "## Feedback from the user", "", feedback);
    }

    lines.push(
      "",
      "## End-of-turn JSON block",
      "",
      "Example (planning phase):",
      "",
      "```json",
      JSON.stringify(
        {
          status: "awaiting_approval",
          artifacts: [adrPath, planPath],
          approvalRequest: {
            action: "proceed_to_next",
            summary: "ADR and implementation plan ready for review.",
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
