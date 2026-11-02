import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  artifactPath as perRoleArtifactPath,
  artifactRelative as perRoleArtifactRelative,
  readArtifact,
  type ArtifactOwner,
} from "../orchestrator/artifacts.js";
import type { RepoTarget, RoleId, RunRecord } from "../orchestrator/types.js";
import type { RoleInputCtx } from "./types.js";
import { workDir } from "../orchestrator/workspaces.js";

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
    const branch = r.branch ? ` · branch: \`${r.branch}\`` : "";
    lines.push(`  - \`${workDir(r)}\` (base: \`${r.baseBranch}\`${branch}${guideline})`);
  }
  if (record.repos.some((r) => r.workPath)) {
    lines.push(
      "",
      "Each path above is **this run's own git worktree** of the repo. Work only there — other runs may be using the original checkout or their own worktrees in parallel.",
    );
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
export function aiGuidelineSection(record: RunRecord, role: RoleId): string {
  const resolved = record.repos
    .map((r) =>
      r.aiGuidelinePath && existsSync(join(workDir(r), r.aiGuidelinePath))
        ? { path: workDir(r), guideline: r.aiGuidelinePath }
        : null,
    )
    .filter((x): x is { path: string; guideline: string } => x !== null);
  if (resolved.length === 0) return "";

  const bullets = resolved.map((r) => `- \`${r.path}\` → \`${r.guideline}\``).join("\n");
  const instruction: Record<RoleId, string> = {
    analyst:
      "Repo(s) in this run ship with an AI guideline document the feature doc must respect. Read the relevant pages and cite them.",
    developer:
      "Consult the AI guideline document for each repo you touch, when it affects architecture or interface decisions; cite the specific page(s) in the ADR when it influenced a choice.",
    unitTester:
      "Follow the testing conventions in the AI guideline document (file layout, naming, mocking rules) for each repo you add tests to.",
    integrationTester:
      "Follow the testing conventions in the AI guideline document (file layout, naming, fixtures, what may be mocked) for each repo you add tests to.",
    reviewer:
      "Review the changes against the AI guideline document(s) below. Cite the specific guideline page per finding where applicable.",
    e2eTester:
      "Follow any end-to-end or UI testing conventions in the AI guideline document (selectors, fixtures, test data).",
    prCreator: "If the AI guideline document prescribes PR conventions (title format, sections), follow them.",
  };
  return ["", "## AI guideline", "", instruction[role], bullets, ""].join("\n");
}

/** Renders the orchestrator signal, hand-back notes, and user feedback for a role prompt. */
export function orchestratorSection(ctx: RoleInputCtx): string {
  const lines: string[] = [];
  if (ctx.signal === "orchestrator_restart") {
    lines.push(
      "",
      "## Orchestrator signal",
      "",
      "The orchestrator restarted while you were working. Check what you already did (git status/log, the artifacts in the run folder) and continue from there. Do not redo completed work.",
    );
  } else if (ctx.signal === "review_fixes_required") {
    lines.push(
      "",
      "## Orchestrator signal",
      "",
      "The review report attached above must be addressed. Fix every BLOCKER/HIGH finding and justify any MED you choose not to act on.",
    );
  } else if (ctx.signal === "create_suite_approved") {
    lines.push(
      "",
      "## Orchestrator signal",
      "",
      "The user APPROVED Playwright suite creation. Install Playwright, scaffold the config, add tests, and run them.",
    );
  }
  if (ctx.handoff) {
    lines.push(
      "",
      `## Handed back by ${ctx.handoff.from}`,
      "",
      ctx.handoff.notes?.trim() || "(no notes — see that role's report attached above)",
    );
  }
  if (ctx.feedback && ctx.feedback.trim()) {
    lines.push("", "## Feedback from the user", "", ctx.feedback.trim());
  }
  return lines.join("\n");
}

/** Shared instruction: acceptance-criteria IDs carried through every downstream artifact. */
export const TRACEABILITY_NOTE =
  "The feature doc numbers its acceptance criteria `AC-1`, `AC-2`, …. Reference those IDs in test names or descriptions and in your report, so every criterion can be traced to the tests that cover it.";

/** Fenced JSON example for the end-of-turn block. */
export function endOfTurnExample(title: string, example: unknown): string {
  return ["", `## End-of-turn JSON block (${title})`, "", "```json", JSON.stringify(example, null, 2), "```"].join("\n");
}

/**
 * Building blocks for per-role Bash allowlists. Each regex is checked against a
 * single command — `sdk/permissions.ts` rejects chaining, pipes, redirects and
 * substitution before these run.
 */
export const BASH = {
  gitRead: /^git\s+(status|diff|log|show|rev-parse)(\s|$)/,
  /** Listing branches only — no create/delete/rename. */
  gitBranchRead: /^git\s+branch(\s+(--show-current|--list|-a|-r|-v|-vv))*\s*$/,
  gitCommit: /^git\s+(add|commit)(\s|$)/,
  /** Discard local edits to files (never switches branches). */
  gitRestore: /^git\s+(restore\s|checkout\s+--\s)/,
  gitStash: /^git\s+stash(\s|$)/,
  catPackageJson: /^cat\s+package\.json$/,
  ls: /^(ls|dir)(\s|$)/,
  /** Unit test runners, typecheck and lint (npm/pnpm scripts named test*, typecheck*, lint*). */
  testRunners: [
    /^npm\s+(test|run\s+(test|typecheck|lint)(:\S+)?)(\s|$)/,
    /^pnpm\s+(test|run\s+(test|typecheck|lint)(:\S+)?)(\s|$)/,
    /^npx\s+(vitest|jest|tsc)(\s|$)/,
  ],
} as const;
