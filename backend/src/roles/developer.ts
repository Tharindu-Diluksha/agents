import type { RunRecord } from "../orchestrator/types.js";
import {  aiGuidelineSection,
  artifactRelative,
  BASH,
  endOfTurnExample,
  headerFor,
  maybeAttach,
  orchestratorSection,
  primaryRepo,
  bashBoundaryLine, stackSection,
  templateRef,
} from "./common.js";
import type { RoleSpec } from "./types.js";
import { workDir } from "../orchestrator/workspaces.js";

/** True once the user approved the plan and branches were created. */
export function planApproved(record: RunRecord): boolean {
  return record.stateHistory.some(
    (h) => h.to === "unit_tests_red_running" || h.to === "developer_implementing",
  );
}

export const developer: RoleSpec = {
  id: "developer",
  title: "Developer",
  promptFile: "developer.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  // May read the ticket for context on JIRA-sourced runs.
  jiraAccess: "issue",
  bashAllowList: [
    BASH.gitRead,
    BASH.gitBranchRead,
    BASH.gitCommit,
    BASH.gitRestore,
    BASH.gitStash,
    /^git\s+fetch(\s|$)/,
    BASH.ls,
  ],
  capabilities: ["test", "lint", "build", "inspect"],
  writeScope: "repos-and-run",
  needsWorkspace: true,
  maxTurns: 100,
  cwdFor(record) {
    return workDir(primaryRepo(record));
  },
  buildInput(record, ctx) {
    const adrPath = artifactRelative(record, "developer", "adr.md");
    const planPath = artifactRelative(record, "developer", "impl-plan.md");
    const planning = record.state === "developer_planning";

    const lines = [
      headerFor(record, "Developer"),
      `## Phase: ${planning ? "1 — Planning" : "2 — Implementation"}`,
      "",
    ];

    if (planning) {
      lines.push(
        "1. Confirm existing tests pass: run the repo's unit test command. If anything is red before you touch the code, emit `status: \"blocked\"` describing which tests failed. Do NOT proceed.",
        `2. Write an ADR to \`${adrPath}\` using \`${templateRef("adr.md")}\`.`,
        `3. Write an implementation plan to \`${planPath}\` using \`${templateRef("impl-plan.md")}\`. List every file to touch, and fill in the **Test plan** section: the unit tests (per AC-id) the Unit Tester will write first, and the integration points the Integration Tester should cover.`,
        "4. End your turn with `approvalRequest.action: \"proceed_to_next\"` so the user can approve the plan. Do NOT implement in this phase.",
        "",
        "## Required reading",
        maybeAttach(record, "analyst", "feature-doc.md", "Feature doc (from Analyst)"),
      );
    } else {
      lines.push(
        "The orchestrator has created the feature branch and the **Unit Tester has already written failing unit tests** from your plan (see the unit test report below). Your job is to make them pass.",
        "",
        "1. Implement the plan. Run the unit tests often; the goal is a fully green suite.",
        "2. Do NOT delete, skip, or weaken the Unit Tester's tests to get green. If you are convinced a test contradicts the feature doc or the approved plan, stop and emit `status: \"blocked\"` with `handoff: { \"nextRole\": \"unitTester\", \"notes\": \"<which test and why>\" }`.",
        "3. Commit incrementally with meaningful messages. DO NOT push.",
        "4. When done, run the full unit suite plus typecheck/lint once more and emit `status: \"done\"`. The orchestrator then sends your change to the Unit Tester for verification, then the Integration Tester, then the Reviewer.",
        "",
        "If a review report or a test report that classifies an **app-bug** is attached below, it is the reason you are being re-run: fix exactly what it describes.",
        "",
        "## Required reading",
        maybeAttach(record, "analyst", "feature-doc.md", "Feature doc (from Analyst)"),
        maybeAttach(record, "developer", "impl-plan.md", "Your approved implementation plan"),
        maybeAttach(record, "unitTester", "unit-test-report.md", "Unit test report"),
        maybeAttach(record, "integrationTester", "integration-test-report.md", "Integration test report"),
        maybeAttach(record, "reviewer", "review-report.md", "Code review report"),
        maybeAttach(record, "e2eTester", "e2e-test-report.md", "E2E test report"),
      );
    }

    lines.push(
      "",
      "## Boundaries",
      "- You MUST NOT push to any remote, and MUST NOT switch branches. The orchestrator manages branches; the PR Creator pushes.",
      bashBoundaryLine(record, "git status/diff/log/show/add/commit/restore/stash/fetch, ls/dir", developer),
      "- File edits are limited to the target repo(s) and this run's artifact folder.",
      stackSection(record, "developer"),
      aiGuidelineSection(record, "developer"),
      orchestratorSection(ctx),
    );

    lines.push(
      planning
        ? endOfTurnExample("planning", {
            status: "awaiting_approval",
            artifacts: [adrPath, planPath],
            approvalRequest: {
              action: "proceed_to_next",
              summary: "ADR and implementation plan ready for review.",
              payloadPaths: [],
            },
            handoff: null,
          })
        : endOfTurnExample("implementation finished", {
            status: "done",
            artifacts: [],
            approvalRequest: null,
            handoff: null,
          }),
    );
    return lines.join("\n");
  },
};
