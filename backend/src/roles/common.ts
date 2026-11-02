import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  artifactPath as perRoleArtifactPath,
  artifactRelative as perRoleArtifactRelative,
  readArtifact,
  type ArtifactOwner,
} from "../orchestrator/artifacts.js";
import type { RepoTarget, RunRecord } from "../orchestrator/types.js";

export function artifactPath(record: RunRecord, role: ArtifactOwner, name: string): string {
  return perRoleArtifactPath(record, role, name);
}

export function artifactRelative(record: RunRecord, role: ArtifactOwner, name: string): string {
  return perRoleArtifactRelative(record, role, name);
}

export function headerFor(record: RunRecord, roleHuman: string): string {
  const lines = [
    `# ${roleHuman} run for ${record.label}`,
    "",
    `- Run id: \`${record.runId}\``,
    sourceLine(record),
    `- Target repos (${record.repos.length}):`,
  ];
  for (const r of record.repos) {
    const guideline = r.aiGuidelinePath ? ` · ai-guideline: \`${r.aiGuidelinePath}\`` : "";
    lines.push(`  - \`${r.path}\` (base: \`${r.baseBranch}\`${guideline})`);
  }
  if (record.repos.length > 1) {
    lines.push("");
    lines.push(
      "**Multi-repo run.** When editing files, use absolute paths. When running shell commands, prefix with `cd <absolutePath> && ` to target a specific repo — the orchestrator's Bash allowlist is scoped to the repos listed above.",
    );
  }
  lines.push("");
  return lines.join("\n");
}

function sourceLine(record: RunRecord): string {
  if (record.source.kind === "jira") {
    return `- JIRA ticket: ${record.source.ticketUrl}`;
  }
  return `- Source: user-provided description (type: \`${record.source.type}\`)`;
}

export function primaryRepo(record: RunRecord): RepoTarget {
  const first = record.repos[0];
  if (!first) throw new Error("run has no repos");
  return first;
}

export function maybeAttach(record: RunRecord, role: ArtifactOwner, name: string, label: string): string {
  const body = readArtifact(artifactPath(record, role, name));
  if (!body) return "";
  const rel = artifactRelative(record, role, name);
  return `\n\n## ${label} (\`${rel}\`)\n\n${body.trim()}\n`;
}

/**
 * If any repo in the run has an `aiGuidelinePath` resolving to an existing
 * folder, emits a per-repo bullet pointing the role at it. Returns an empty
 * string when no repo in the run has a resolved AI guideline doc.
 */
export function aiGuidelineSection(record: RunRecord, role: "analyst" | "developer" | "reviewer"): string {
  const resolved = record.repos
    .map((r) =>
      r.aiGuidelinePath && existsSync(join(r.path, r.aiGuidelinePath))
        ? { path: r.path, guideline: r.aiGuidelinePath }
        : null,
    )
    .filter((x): x is { path: string; guideline: string } => x !== null);
  if (resolved.length === 0) return "";

  const bullets = resolved.map((r) => `- \`${r.path}\` → \`${r.guideline}\``).join("\n");
  const header = "## AI guideline";

  if (role === "analyst") {
    return [
      "",
      header,
      "",
      "Repo(s) in this run ship with an AI guideline document the feature doc must respect. Read the relevant pages and cite them.",
      bullets,
      "",
    ].join("\n");
  }
  if (role === "developer") {
    return [
      "",
      header,
      "",
      "Consult the AI guideline document for each repo you touch, when it affects architecture or interface decisions; cite the specific page(s) in the ADR when it influenced a choice.",
      bullets,
      "",
    ].join("\n");
  }
  return [
    "",
    header,
    "",
    "Review the changes against the AI guideline document(s) below. Cite the specific guideline page per finding where applicable.",
    bullets,
    "",
  ].join("\n");
}
