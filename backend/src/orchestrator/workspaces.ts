import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, paths } from "../config.js";
import { installDependencies } from "../external/deps.js";
import {
  addWorktree,
  checkoutOrCreateBranch,
  isWorktreeRoot,
  listWorktrees,
  removeWorktree,
  resolveBaseRef,
  switchWorktreeBranch,
} from "../external/git.js";
import { repoSlug } from "./artifacts.js";
import type { RepoTarget, RunRecord } from "./types.js";

/*
 * Per-run workspaces. Each run gets its own git worktree per repo under
 * `paths.worktreesDir/<runId>/<repoSlug>`, so parallel runs never share a
 * working tree and the user's own checkout is never touched.
 *
 * Lifecycle:
 *  1. prepareWorkspaces — before the first role that works in the repos
 *     (Developer planning): worktree detached at the latest base, untracked
 *     files copied over, dependencies installed.
 *  2. setFeatureBranch — at the branch gate: the worktree switches to the
 *     approved branch. The path stays the same, which SDK session resume needs.
 *  3. removeWorkspaces — on request once the run is finished or paused.
 *     The branch stays; if the run continues, the worktree is re-created on it.
 */

/** Ref to diff against for this repo (what the worktree started from, else the base branch). */
export function diffBase(repo: RepoTarget): string {
  return repo.baseRef ?? repo.baseBranch;
}

/** Where roles work for this repo: its worktree when one exists, else the original checkout. */
export function workDir(repo: RepoTarget): string {
  return repo.workPath ?? repo.path;
}

export function usesWorktrees(record: RunRecord): boolean {
  return record.workspace === "worktree";
}

/** Stable worktree location for repo #index of a run. */
export function worktreePathFor(record: RunRecord, index: number): string {
  const slugs = record.repos.map((r) => repoSlug(r.path));
  const slug = slugs[index]!;
  const unique = slugs.filter((s) => s === slug).length > 1 ? `${slug}-${index + 1}` : slug;
  return join(paths.worktreesDir, record.runId, unique);
}

export type ProgressFn = (message: string) => void;

/**
 * Ensures every repo of a worktree-mode run has its worktree. Idempotent:
 * an existing worktree at the expected path is reused. Mutates `record.repos`
 * (the caller saves).
 */
export async function prepareWorkspaces(record: RunRecord, progress: ProgressFn): Promise<void> {
  if (!usesWorktrees(record)) return;
  for (let i = 0; i < record.repos.length; i++) {
    const repo = record.repos[i]!;
    const target = worktreePathFor(record, i);

    if (existsSync(target) && (await isWorktreeRoot(target))) {
      repo.workPath = target;
      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    if (repo.branch) {
      // Re-created after removal: put it back on the run's branch.
      progress(`creating worktree for ${repo.path} on branch ${repo.branch} at ${target}`);
      await addWorktree(repo.path, target, { branch: repo.branch });
    } else {
      const base = await resolveBaseRef(repo.path, repo.baseBranch, config.worktree.fetchBase);
      if (base.fetchError) progress(`could not fetch origin/${repo.baseBranch} (${base.fetchError}); using ${base.ref}`);
      progress(`creating worktree for ${repo.path} at ${target} (detached at ${base.ref})`);
      await addWorktree(repo.path, target, { ref: base.ref });
      repo.baseRef = base.ref;
    }
    repo.workPath = target;

    for (const rel of config.worktree.copyFiles) {
      const src = join(repo.path, rel);
      if (!existsSync(src) || existsSync(join(target, rel))) continue;
      mkdirSync(dirname(join(target, rel)), { recursive: true });
      copyFileSync(src, join(target, rel));
      progress(`copied ${rel} into the worktree`);
    }

    if (config.worktree.installDeps) {
      progress(`installing dependencies in ${target} …`);
      const cmd = await installDependencies(target);
      progress(cmd ? `dependencies installed (${cmd})` : "no package.json; skipped dependency install");
    }
  }
}

/** Puts the run's workspace for `repo` on `branch` (worktree, or the checkout for in-place runs). */
export async function setFeatureBranch(record: RunRecord, repo: RepoTarget, branch: string): Promise<string> {
  if (!usesWorktrees(record)) {
    const outcome = await checkoutOrCreateBranch(repo.path, branch, repo.baseBranch);
    repo.branch = branch;
    return outcome;
  }
  if (!repo.workPath) throw new Error(`no worktree prepared for ${repo.path}`);
  const holder = await worktreeHoldingBranch(repo.path, branch, repo.workPath);
  if (holder) {
    throw new Error(`branch ${branch} is already checked out in ${describeHolder(holder)}; pick another name`);
  }
  const outcome = await switchWorktreeBranch(repo.workPath, branch);
  repo.branch = branch;
  return outcome;
}

/** Path of another worktree (not `except`) that has `branch` checked out, or null. */
export async function worktreeHoldingBranch(repoPath: string, branch: string, except?: string | null): Promise<string | null> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const wt of await listWorktrees(repoPath)) {
    if (wt.branch === branch && (!except || norm(wt.path) !== norm(except))) return wt.path;
  }
  return null;
}

/** "run <id> (path)" when the path is one of our worktrees, otherwise the path. */
export function describeHolder(path: string): string {
  const root = paths.worktreesDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = path.replace(/\\/g, "/");
  if (p.startsWith(root + "/")) {
    const runId = p.slice(root.length + 1).split("/")[0];
    return `run ${runId} (${path})`;
  }
  return path;
}

export interface RemoveResult {
  repoPath: string;
  workPath: string;
  removed: boolean;
  error?: string;
}

/**
 * Removes the run's worktrees. Without `force`, git refuses to remove a
 * worktree with uncommitted changes and that repo is reported as an error.
 */
export async function removeWorkspaces(record: RunRecord, force: boolean): Promise<RemoveResult[]> {
  const results: RemoveResult[] = [];
  for (const repo of record.repos) {
    if (!repo.workPath) continue;
    const workPath = repo.workPath;
    try {
      if (existsSync(workPath)) await removeWorktree(repo.path, workPath, force);
      repo.workPath = null;
      results.push({ repoPath: repo.path, workPath, removed: true });
    } catch (err) {
      results.push({ repoPath: repo.path, workPath, removed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
