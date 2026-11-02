import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { nanoid } from "nanoid";
import { currentBranch, pushBranch, runCmd } from "./git.js";

export interface CreatePrInput {
  repoPath: string;
  baseBranch: string;
  body: string;
  titleHint: string;
}

/**
 * Pushes the current branch and opens a PR via `gh pr create`.
 * Returns the PR URL printed by gh.
 */
export async function createPr(input: CreatePrInput): Promise<string> {
  const { repoPath, baseBranch, body, titleHint } = input;
  const branch = await currentBranch(repoPath);
  if (branch === baseBranch) {
    throw new Error(`refusing to open PR: HEAD is on base branch ${baseBranch}`);
  }
  await pushBranch(repoPath, branch);

  const title = deriveTitle(body, titleHint);
  const bodyFile = join(tmpdir(), `pr-body-${nanoid(8)}.md`);
  writeFileSync(bodyFile, body, "utf8");

  try {
    const r = await runCmd(
      "gh",
      ["pr", "create", "--base", baseBranch, "--head", branch, "--title", title, "--body-file", bodyFile],
      repoPath,
    );
    if (r.code !== 0) {
      throw new Error(`gh pr create failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    const urlLine = r.stdout.split("\n").map((l) => l.trim()).find((l) => l.startsWith("https://"));
    return urlLine ?? r.stdout.trim();
  } finally {
    try {
      unlinkSync(bodyFile);
    } catch {
      /* best-effort */
    }
  }
}

function deriveTitle(body: string, hint: string): string {
  const firstHeading = body.split("\n").map((l) => l.trim()).find((l) => l.startsWith("# "));
  if (firstHeading) return firstHeading.slice(2).trim().slice(0, 120);
  return `${hint}: feature update`.slice(0, 120);
}
