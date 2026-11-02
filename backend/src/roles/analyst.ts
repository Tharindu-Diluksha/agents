import { ensureRoleDir } from "../orchestrator/artifacts.js";
import { aiGuidelineSection, artifactRelative, headerFor, orchestratorSection } from "./common.js";
import type { RoleSpec } from "./types.js";

export const analyst: RoleSpec = {
  id: "analyst",
  title: "Product Analyst",
  promptFile: "analyst.md",
  // Note: MCP JIRA tools are listed here but the role is instructed not to
  // call them when the run source is manual. The orchestrator does not
  // post-filter — the role prompt is the gate for manual-source runs.
  allowedTools: [
    "Read",
    "Glob",
    "Grep",
    "Write",
    "Edit",
    "mcp__atlassian-local__getJiraIssue",
    "mcp__atlassian-local__searchJiraIssuesUsingJql",
    "mcp__atlassian-local__getAccessibleAtlassianResources",
    "mcp__atlassian-local__atlassianUserInfo",
  ],
  bashAllowList: [],
  writeScope: "run",
  maxTurns: 30,
  cwdFor(record) {
    return ensureRoleDir(record.runId, "analyst");
  },
  buildInput(record, ctx) {
    const featureDocPath = artifactRelative(record, "analyst", "feature-doc.md");
    const commentPath = artifactRelative(record, "analyst", "proposed-jira-comment.md");
    const isJira = record.source.kind === "jira";

    const lines = [
      headerFor(record, "Product Analyst"),
      "## Your task",
      "",
    ];
    if (isJira) {
      const ticket = record.source.kind === "jira" ? record.source.ticket : "";
      lines.push(
        `1. Fetch the JIRA ticket \`${ticket}\` using the \`mcp__atlassian-local__getJiraIssue\` tool.`,
        `2. Analyse the story carefully. Call out missing acceptance criteria, ambiguous requirements, dependencies, or risks.`,
        `3. Write the feature documentation to \`${featureDocPath}\` using the shape in \`templates/feature-doc.md\`.`,
        `4. If (and ONLY if) you have substantive feedback the team should see on the ticket (clarifying questions, gaps, misalignments), write a proposed comment to \`${commentPath}\` and set \`approvalRequest.action\` to \`post_jira_comment\`. Otherwise set the request to \`proceed_to_next\`.`,
        "",
        "You do NOT have permission to post the JIRA comment yourself. The orchestrator will post it after the user approves.",
      );
    } else {
      const m = record.source.kind === "manual" ? record.source : null;
      lines.push(
        `There is no JIRA ticket for this run; the user provided a direct description below. Do NOT call any JIRA tools.`,
        "",
        `**User-supplied source** (type: \`${m?.type ?? ""}\`)`,
        "",
        `### ${m?.title ?? ""}`,
        "",
        m?.description ?? "",
        "",
        "**Acceptance criteria (as given):**",
        ...(m?.acceptanceCriteria.length ? m.acceptanceCriteria.map((c) => `- ${c}`) : ["- (none provided)"]),
        "",
        `1. Analyse the description above. Call out missing acceptance criteria, ambiguous requirements, dependencies, or risks.`,
        `2. Write the feature documentation to \`${featureDocPath}\` using the shape in \`templates/feature-doc.md\`. Treat the description above as the authoritative source.`,
        `3. End your turn with \`approvalRequest.action: "proceed_to_next"\`. Do NOT propose a JIRA comment — there is no ticket.`,
      );
    }
    lines.push(
      "",
      "**Acceptance criteria IDs.** Number every acceptance criterion in the feature doc as `AC-1`, `AC-2`, …. Every downstream role (Developer, Unit/Integration/E2E Testers, PR Creator) references these IDs, so keep them stable across re-runs.",
    );
    lines.push(aiGuidelineSection(record, "analyst"));
    if (record.repos.length > 1) {
      lines.push("", "This run spans multiple repos. In the feature doc, clearly state which repo gets which change; the Developer role will plan work accordingly.");
    }
    lines.push(orchestratorSection(ctx));
    lines.push(
      "",
      "## End-of-turn JSON block",
      "",
      "End your turn with a fenced ```json block matching the role contract. Example:",
      "",
      "```json",
      JSON.stringify(
        {
          status: "awaiting_approval",
          artifacts: [featureDocPath],
          approvalRequest: {
            action: "proceed_to_next",
            summary: "Feature doc ready for review.",
            payloadPaths: [],
          },
          handoff: { nextRole: "developer" },
        },
        null,
        2,
      ),
      "```",
    );
    return lines.join("\n");
  },
};
