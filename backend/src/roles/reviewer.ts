import { z } from "zod";
import type { RunRecord } from "../orchestrator/types.js";
import {  aiGuidelineSection,
  artifactPath,
  artifactRelative,
  BASH,
  endOfTurnExample,
  headerFor,
  maybeAttach,
  orchestratorSection,
  primaryRepo,
  stackSection,
  templateRef,
} from "./common.js";
import { readArtifact } from "../orchestrator/artifacts.js";
import type { RoleSpec } from "./types.js";
import { diffBase, workDir } from "../orchestrator/workspaces.js";

const FindingsSchema = z.object({
  blocker: z.number().int().min(0),
  high: z.number().int().min(0),
  med: z.number().int().min(0),
  low: z.number().int().min(0),
  nit: z.number().int().min(0),
});
export type ReviewFindings = z.infer<typeof FindingsSchema>;

/** Reads the Reviewer's machine-readable severity counts, or null if missing/invalid. */
export function readReviewFindings(record: RunRecord): ReviewFindings | null {
  const raw = readArtifact(artifactPath(record, "reviewer", "review-findings.json"));
  if (!raw) return null;
  try {
    const parsed = FindingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const reviewer: RoleSpec = {
  id: "reviewer",
  title: "Code Reviewer",
  promptFile: "reviewer.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    BASH.gitRead,
    BASH.gitBranchRead,
    BASH.ls,
  ],
  capabilities: ["lint", "audit", "inspect"],
  // Read-only on source: the Reviewer can only write its own report files.
  writeScope: "run",
  needsWorkspace: true,
  maxTurns: 50,
  cwdFor(record) {
    return workDir(primaryRepo(record));
  },
  buildInput(record, ctx) {
    const reportPath = artifactRelative(record, "reviewer", "review-report.md");
    const findingsPath = artifactRelative(record, "reviewer", "review-findings.json");
    const diffScope = record.repos
      .map((r) => `- \`${workDir(r)}\`: \`git diff ${diffBase(r)}...HEAD\` and \`git log ${diffBase(r)}..HEAD\``)
      .join("\n");
    const lines = [
      headerFor(record, "Code Reviewer"),
      "## Scope",
      "",
      "Review only this run's changes — production code and the tests the Unit and Integration Testers added:",
      diffScope,
      "",
      "Check against:",
      "1. **Security**: OWASP top 10. SQL injection, XSS, auth bypass, path traversal, insecure deserialization, secrets committed, SSRF.",
      "2. **Bug patterns**: null/undefined handling, race conditions, resource leaks, error swallowing, off-by-one.",
      "3. **AI guideline** (see the AI guideline section below, if present): any coding conventions, architecture rules, or review rubric the repo codifies for the AI to follow.",
      "4. **Tests**: does every AC-id have unit and/or integration coverage? Are any tests weakened, skipped, or asserting the wrong thing?",
      "5. **General code quality**: dead code, misleading names, unnecessary complexity.",
      stackSection(record, "reviewer"),
      aiGuidelineSection(record, "reviewer"),
      "",
      "You have read-only access to source, plus git diff/log and lint/typecheck/audit. You MAY NOT modify source files; you can only write the two report files below.",
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "adr.md", "ADR"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      maybeAttach(record, "unitTester", "unit-test-report.md", "Unit test report"),
      maybeAttach(record, "integrationTester", "integration-test-report.md", "Integration test report"),
      "",
      "## Output",
      "",
      `1. Write your findings to \`${reportPath}\` using the shape in \`${templateRef("review-report.md")}\`. Each finding needs a severity (BLOCKER/HIGH/MED/LOW/NIT), the file + line, a short description, and a recommended fix.`,
      `2. Write the finding counts to \`${findingsPath}\` as JSON exactly like \`{"blocker":0,"high":1,"med":2,"low":0,"nit":3}\`. The orchestrator uses this file to route the run.`,
      "",
      "End your turn with `approvalRequest.action: \"proceed_to_next\"`. The user (or the orchestrator's auto-routing, if enabled) decides whether findings go back to the Developer or the run moves on to E2E testing.",
      orchestratorSection(ctx),
      endOfTurnExample("review complete", {
        status: "awaiting_approval",
        artifacts: [reportPath, findingsPath],
        approvalRequest: {
          action: "proceed_to_next",
          summary: "Review complete: 0 blocker / 1 high / 2 med / 0 low / 3 nit.",
          payloadPaths: [],
        },
        handoff: null,
      }),
    ];
    return lines.join("\n");
  },
};
