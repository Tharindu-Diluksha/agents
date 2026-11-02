import type { RoleSpec } from "./types.js";
import { aiGuidelineSection, artifactRelative, headerFor, maybeAttach, primaryRepo } from "./common.js";

export const reviewer: RoleSpec = {
  id: "reviewer",
  promptFile: "reviewer.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    /^git\s+(status|diff|log|show|branch|rev-parse)/,
    /^npm\s+(audit|run\s+(lint|typecheck))(\s|$)/,
    /^npx\s+(eslint|tsc)(\s|$)/,
    /^pnpm\s+(audit|run\s+(lint|typecheck))(\s|$)/,
    /^cat\s+package\.json$/,
    /^ls\b/,
    /^dir\b/,
  ],
  maxTurns: 50,
  cwdFor(record) {
    return primaryRepo(record).path;
  },
  buildInput(record, { feedback }) {
    const reportPath = artifactRelative(record, "reviewer", "review-report.md");
    const lines = [
      headerFor(record, "Code Reviewer"),
      "## Scope",
      "",
      "Review the changes made by the Developer against:",
      "1. **Security**: OWASP top 10. SQL injection, XSS, auth bypass, path traversal, insecure deserialization, secrets committed, SSRF.",
      "2. **Bug patterns**: null/undefined handling, race conditions, resource leaks, error swallowing, off-by-one.",
      "3. **AI guideline** (see the AI guideline section below, if present): any coding conventions, architecture rules, or review rubric the repo codifies for the AI to follow.",
      "4. **General code quality**: dead code, misleading names, unnecessary complexity, missing tests for new behavior.",
      aiGuidelineSection(record, "reviewer"),
      "",
      "You have read-only tools plus git diff/log and lint/typecheck/audit. You MAY NOT modify source files.",
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "adr.md", "ADR"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      "",
      "## Output",
      "",
      `Write your findings to \`${reportPath}\` using the shape in \`templates/review-report.md\`. Each finding needs a severity (BLOCKER/HIGH/MED/LOW/NIT), the file + line, a short description, and a recommended fix.`,
      "",
      "End your turn with `approvalRequest.action: \"proceed_to_next\"`. The user decides whether findings are addressed (back to Developer) or ignored (on to Tester).",
    ];
    if (feedback) {
      lines.push("", "## Note from orchestrator", "", feedback);
    }
    lines.push(
      "",
      "## End-of-turn JSON block",
      "",
      "```json",
      JSON.stringify(
        {
          status: "awaiting_approval",
          artifacts: [reportPath],
          approvalRequest: {
            action: "proceed_to_next",
            summary: "Review complete; see report for findings.",
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
