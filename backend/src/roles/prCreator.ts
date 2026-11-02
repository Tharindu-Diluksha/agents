import { perRepoPrDescriptionName } from "../orchestrator/artifacts.js";
import type { RoleSpec } from "./types.js";
import { diffBase, workDir } from "../orchestrator/workspaces.js";
import { aiGuidelineSection, artifactRelative, BASH, headerFor, maybeAttach, orchestratorSection, primaryRepo } from "./common.js";

export const prCreator: RoleSpec = {
  id: "prCreator",
  title: "PR Creator",
  promptFile: "pr-creator.md",
  allowedTools: ["Read", "Glob", "Grep", "Write", "Edit", "Bash"],
  bashAllowList: [
    BASH.gitRead,
    BASH.gitBranchRead,
    /^git\s+push\s+(-u\s+)?origin\s+[^\s-]\S*$/,
    /^gh\s+(auth\s+status|repo\s+view|pr\s+view\b)/,
    /^cat\s+(package\.json|\.github\/pull_request_template\.md)$/,
    BASH.ls,
  ],
  writeScope: "run",
  needsWorkspace: true,
  maxTurns: 40,
  cwdFor(record) {
    return workDir(primaryRepo(record));
  },
  buildInput(record, ctx) {
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
      "1. Prefix shell commands with `cd <absolutePath> && ` so the Bash allowlist resolves them to that repo. Example: `cd \"" + workDir(record.repos[0]!) + "\" && git status`.",
      "2. Make sure the working tree is clean (`git status`). If dirty, emit `status: \"blocked\"` describing the uncommitted changes.",
      "3. Confirm the current branch isn't the base branch. If it is, emit `status: \"blocked\"` — the Developer should have been on a feature branch.",
      "4. Push the branch to `origin`.",
      "5. Compute the diff against the ref listed for that repo below (`git diff <ref>...HEAD`, `git log <ref>..HEAD`).",
      "6. If `.github/pull_request_template.md` exists in that repo, honour its section headings. Otherwise use the shape in `templates/pr-description.md`.",
      "   Include a **traceability table**: one row per acceptance criterion (AC-id) listing the unit, integration and E2E tests that cover it, taken from the test reports below.",
      "7. Write the PR description to the per-repo file listed below.",
      "",
      "## Per-repo PR description files to write",
      "",
      ...perRepoPaths.map((p) => `- \`${p.file}\` ← for repo \`${workDir(p.repo)}\` (PR base: \`${p.repo.baseBranch}\`; diff against \`${diffBase(p.repo)}\`)`),
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
      maybeAttach(record, "unitTester", "unit-test-report.md", "Unit test report"),
      maybeAttach(record, "integrationTester", "integration-test-report.md", "Integration test report"),
      maybeAttach(record, "e2eTester", "e2e-test-report.md", "E2E test report"),
      aiGuidelineSection(record, "prCreator"),
      orchestratorSection(ctx),
    ];
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
