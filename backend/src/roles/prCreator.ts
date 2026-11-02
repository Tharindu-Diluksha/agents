import { perRepoPrDescriptionName } from "../orchestrator/artifacts.js";
import type { RoleSpec } from "./types.js";
import { artifactRelative, headerFor, maybeAttach, primaryRepo } from "./common.js";

export const prCreator: RoleSpec = {
  id: "prCreator",
  promptFile: "pr-creator.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    /^git\s+(status|diff|log|show|branch|rev-parse|push\s+(-u\s+)?origin\s+\S+$)/,
    /^gh\s+(auth\s+status|repo\s+view|pr\s+view\b)/,
    /^cat\s+(package\.json|\.github\/pull_request_template\.md)$/,
    /^ls\b/,
    /^dir\b/,
  ],
  maxTurns: 40,
  cwdFor(record) {
    return primaryRepo(record).path;
  },
  buildInput(record, { feedback }) {
    const perRepoPaths = record.repos.map((r) => ({
      repo: r,
      file: artifactRelative(record, "prCreator", perRepoPrDescriptionName(r)),
    }));

    const lines = [
      headerFor(record, "PR Creator"),
      "## Scope",
      "",
      record.repos.length === 1
        ? `This run has a single target repo. Produce one PR description.`
        : `This run has ${record.repos.length} target repos. Produce **one PR description per repo** — one draft file per repo, listed below.`,
      "",
      "For each repo:",
      "",
      "1. Prefix shell commands with `cd <absolutePath> && ` so the Bash allowlist resolves them to that repo. Example: `cd \"" + record.repos[0]!.path + "\" && git status`.",
      "2. Make sure the working tree is clean (`git status`). If dirty, emit `status: \"blocked\"` describing the uncommitted changes.",
      "3. Confirm the current branch isn't the base branch. If it is, emit `status: \"blocked\"` — the Developer should have been on a feature branch.",
      "4. Push the branch to `origin`.",
      "5. Compute the diff against the repo's base branch (`git diff <base>...HEAD`, `git log <base>..HEAD`).",
      "6. If `.github/pull_request_template.md` exists in that repo, honour its section headings. Otherwise use the shape in `templates/pr-description.md`.",
      "7. Write the PR description to the per-repo file listed below.",
      "",
      "## Per-repo PR description files to write",
      "",
      ...perRepoPaths.map((p) => `- \`${p.file}\` ← for repo \`${p.repo.path}\` (base: \`${p.repo.baseBranch}\`)`),
      "",
      "After all files are written, emit a single `approvalRequest.action: \"create_pr\"` with `payloadPaths` containing every per-repo file. The orchestrator (not you) will run `gh pr create` once per repo after the user approves.",
      "",
      "You MAY push each branch (git push). You MUST NOT run `gh pr create` yourself.",
      "",
      "## Required reading",
      maybeAttach(record, "analyst", "feature-doc.md", "Feature doc"),
      maybeAttach(record, "developer", "adr.md", "ADR"),
      maybeAttach(record, "developer", "impl-plan.md", "Implementation plan"),
      maybeAttach(record, "reviewer", "review-report.md", "Review report"),
      maybeAttach(record, "tester", "test-report.md", "Test report"),
    ];
    if (feedback) {
      lines.push("", "## Feedback", "", feedback);
    }
    lines.push(
      "",
      "## End-of-turn JSON block",
      "",
      "```json",
      JSON.stringify(
        {
          status: "awaiting_approval",
          artifacts: perRepoPaths.map((p) => p.file),
          approvalRequest: {
            action: "create_pr",
            summary: `PR drafts ready for ${perRepoPaths.length} repo(s).`,
            payloadPaths: perRepoPaths.map((p) => p.file),
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
