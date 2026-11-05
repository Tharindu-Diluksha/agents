import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, paths } from "../config.js";
import { branchExists } from "../external/git.js";
import { describeHolder, usesWorktrees, worktreeHoldingBranch } from "./workspaces.js";
import { log } from "../log.js";
import { roleArtifactDir, toRelative } from "./artifacts.js";
import type { RunRecord } from "./types.js";

export interface BranchProposal {
  repoPath: string;
  baseBranch: string;
  /** Branch the run already uses for this repo (if the gate is being re-done), else null. */
  currentBranch: string | null;
  suggestedBranch: string;
  /** Why the suggestion differs from the plain template, if it does. */
  note?: string;
}

/**
 * Extracts a short, filesystem/git-friendly slug from the Analyst's feature
 * doc title. Falls back to "feature" if no title can be found.
 */
export function deriveFeatureSlug(record: RunRecord): string {
  const featureDocPath = join(paths.runsDir, record.runId, "analyst", "feature-doc.md");
  if (!existsSync(featureDocPath)) return "feature";
  const text = readFileSync(featureDocPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("# ")) continue;
    const title = line.replace(/^#\s+/, "").replace(/^Feature:\s*/i, "").trim();
    const slug = slugify(title);
    if (slug.length > 0) return slug;
  }
  return "feature";
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function renderBranchName(label: string, slug: string): string {
  const base = config.branchNameTemplate
    .replace(/\{ticket\}/g, label.toLowerCase())
    .replace(/\{label\}/g, label.toLowerCase())
    .replace(/\{slug\}/g, slug);
  // git branch names: lowercase, slashes allowed, no spaces or weird chars.
  return base.replace(/[^a-z0-9/_-]/g, "-").replace(/-{2,}/g, "-").slice(0, 80);
}

/**
 * Builds one branch proposal per repo from BRANCH_NAME_TEMPLATE.
 *
 * It never suggests "whatever the repo is on right now": with parallel runs
 * that could be another run's feature branch. If the templated name is
 * already checked out in another worktree (another run, or the user's own
 * checkout), a run-specific suffix is added and the reason is noted.
 */
export async function proposeBranches(record: RunRecord): Promise<BranchProposal[]> {
  const slug = deriveFeatureSlug(record);
  const base = renderBranchName(record.label, slug);
  const suffix = record.runId.split("-").pop()?.toLowerCase().replace(/[^a-z0-9]/g, "") || "run";
  const out: BranchProposal[] = [];
  for (const repo of record.repos) {
    let suggested = base;
    let note: string | undefined;
    try {
      // In-place runs check out in the user's checkout, so that one doesn't count as a conflict.
      const except = usesWorktrees(record) ? repo.workPath : repo.path;
      const holder = await worktreeHoldingBranch(repo.path, base, except);
      if (holder) {
        suggested = `${base}-${suffix}`.slice(0, 80);
        note = `"${base}" is already checked out in ${describeHolder(holder)}, so a run-specific name is suggested.`;
      } else if (await branchExists(repo.path, base)) {
        note = `Branch "${base}" already exists; this run will continue on it. Rename it to start fresh.`;
      }
    } catch (err) {
      log.warn("branches.inspect_failed", { repo: repo.path, err: errMsg(err) });
    }
    out.push({
      repoPath: repo.path,
      baseBranch: repo.baseBranch,
      currentBranch: repo.branch ?? null,
      suggestedBranch: suggested,
      note,
    });
  }
  return out;
}

export function writeProposedBranches(runId: string, proposals: BranchProposal[]): string {
  const abs = join(roleArtifactDir(runId, "orchestrator"), "proposed-branches.json");
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ perRepo: proposals }, null, 2), "utf8");
  return toRelative(abs);
}

export function readProposedBranches(runId: string): BranchProposal[] | null {
  const abs = join(paths.runsDir, runId, "orchestrator", "proposed-branches.json");
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as { perRepo?: BranchProposal[] };
    return parsed.perRepo ?? null;
  } catch {
    return null;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
