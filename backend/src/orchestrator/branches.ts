import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, paths } from "../config.js";
import { currentBranch } from "../external/git.js";
import { log } from "../log.js";
import type { RunRecord } from "./types.js";

export interface BranchProposal {
  repoPath: string;
  baseBranch: string;
  currentBranch: string | null;
  suggestedBranch: string;
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
 * Builds one branch proposal per repo. If a repo is already on a non-base
 * branch (e.g. the user manually checked something out), that existing name is
 * suggested instead so we never silently overwrite the user's choice.
 */
export async function proposeBranches(record: RunRecord): Promise<BranchProposal[]> {
  const slug = deriveFeatureSlug(record);
  const out: BranchProposal[] = [];
  for (const repo of record.repos) {
    let current: string | null = null;
    try {
      current = await currentBranch(repo.path);
    } catch (err) {
      log.warn("branches.current_branch_failed", { repo: repo.path, err: errMsg(err) });
    }
    const suggested =
      current && current !== repo.baseBranch
        ? current
        : renderBranchName(record.label, slug);
    out.push({
      repoPath: repo.path,
      baseBranch: repo.baseBranch,
      currentBranch: current,
      suggestedBranch: suggested,
    });
  }
  return out;
}

export function writeProposedBranches(runId: string, proposals: BranchProposal[]): string {
  const relative = `runs/${runId}/orchestrator/proposed-branches.json`;
  const abs = join(paths.repoRoot, relative);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({ perRepo: proposals }, null, 2), "utf8");
  return relative;
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
