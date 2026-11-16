import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { config, paths } from "../config.js";
import { installDependencies } from "../external/deps.js";
import {
  addWorktree,
  isToolchainOutput,
  uncommittedPaths,
  checkoutOrCreateBranch,
  currentBranch,
  isWorkingTreeClean,
  isWorktreeRoot,
  listWorktrees,
  removeWorktree,
  resolveBaseRef,
  switchWorktreeBranch,
} from "../external/git.js";
import { repoSlug } from "./artifacts.js";
import { projectsOf, type StackId } from "../stacks.js";
import { allocatePortBlock } from "./ports.js";
import { listRuns } from "./runStore.js";
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

let portLock: Promise<unknown> = Promise.resolve();
function withPortLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = portLock.then(fn, fn);
  portLock = next.catch(() => undefined);
  return next;
}

/**
 * Ensures every repo of a worktree-mode run has its worktree. Idempotent:
 * an existing worktree at the expected path is reused. Mutates `record.repos`
 * (the caller saves).
 */
export async function prepareWorkspaces(record: RunRecord, progress: ProgressFn): Promise<void> {
  if (!usesWorktrees(record)) return;
  if (!record.ports) {
    // Serialised: two runs preparing at once must not both pick the same free block.
    const ports = await withPortLock(async () => {
      // A run holds its block from allocation until its worktrees are removed (ports → null).
      const others = listRuns().filter((r) => r.runId !== record.runId && r.ports);
      const block = await allocatePortBlock(others);
      record.ports = block; // claim before releasing the lock
      return block;
    });
    progress(`reserved ports ${ports.base}–${ports.base + ports.count - 1} for this run`);
  }
  for (let i = 0; i < record.repos.length; i++) {
    const repo = record.repos[i]!;
    const target = worktreePathFor(record, i);

    if (existsSync(target) && (await isWorktreeRoot(target))) {
      repo.workPath = target;
      // Only an install that started and failed is retried; older runs (field absent) are left alone.
      if (repo.depsInstalled === false) {
        progress(`retrying the dependency install that failed last time in ${target}`);
        await installRepoDependencies(repo, target, progress);
      }
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

    await installRepoDependencies(repo, target, progress);
  }
}

/**
 * Installs the worktree's dependencies, one install per project folder (a
 * monorepo's web/ and api/ each get their own). `depsInstalled` is false
 * until every install succeeded, so a failed install is retried the next time
 * the worktree is reused instead of leaving the roles without dependencies.
 */
async function installRepoDependencies(repo: RepoTarget, target: string, progress: ProgressFn): Promise<void> {
  if (!config.worktree.installDeps) return;
  repo.depsInstalled = false;
  const byDir = new Map<string, StackId[]>();
  for (const p of projectsOf(repo)) byDir.set(p.dir, [...(byDir.get(p.dir) ?? []), p.stack]);
  for (const [dir, stacks] of byDir) {
    const where = dir === "." ? target : join(target, dir);
    progress(`installing dependencies in ${where} (${stacks.join(", ")}) …`);
    const ran = await installDependencies(where, stacks);
    progress(ran ? `dependencies installed: ${ran}` : "nothing to install for this stack");
  }
  repo.depsInstalled = true;
}

/**
 * Why a "branch in my checkout" (in-place) run can't start on these repos, or
 * null. Roles plan against the checkout as it is and the branch gate switches
 * it, so it must be clean and on the base branch, and no other in-place run
 * may be using it.
 */
export async function inPlaceProblem(repos: Array<{ path: string; baseBranch: string }>): Promise<string | null> {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const active = listRuns().filter((r) => r.workspace === "in-place" && r.state !== "done" && r.state !== "failed");
  for (const repo of repos) {
    const other = active.find((r) => r.repos.some((x) => norm(x.path) === norm(repo.path)));
    if (other) {
      return `${repo.path} is already used by run ${other.runId}, which works in the same checkout. Finish or archive it, or use an isolated worktree.`;
    }
    let clean: boolean;
    let branch: string;
    try {
      clean = await isWorkingTreeClean(repo.path);
      branch = await currentBranch(repo.path);
    } catch (err) {
      return `${repo.path} is not a usable git checkout: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!clean) return `${repo.path} has uncommitted changes. Commit or stash them first, or use an isolated worktree.`;
    if (branch !== repo.baseBranch) {
      return `${repo.path} is on branch ${branch}, not ${repo.baseBranch}. Switch to ${repo.baseBranch} first, or use an isolated worktree.`;
    }
  }
  return null;
}

/** Puts the run's workspace for `repo` on `branch` (worktree, or the checkout for in-place runs). */
export async function setFeatureBranch(record: RunRecord, repo: RepoTarget, branch: string): Promise<string> {
  if (!usesWorktrees(record)) {
    // Branch mode: a new branch in the user's checkout, off the latest base (origin/<base> when it exists).
    const base = await resolveBaseRef(repo.path, repo.baseBranch, config.worktree.fetchBase);
    const outcome = await checkoutOrCreateBranch(repo.path, branch, base.ref);
    repo.baseRef = base.ref;
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

/** A path like `.venv/` or `node_modules/` (git lists untracked dirs with a trailing slash). */
function isToolchainDir(p: string): boolean {
  return isToolchainOutput(`${p.replace(/\/+$/, "")}/x`);
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
      if (existsSync(workPath)) {
        // Files the orchestrator put there itself (WORKTREE_COPY_FILES, an
        // un-ignored .venv…) don't count as the run's uncommitted work.
        const onlyOurs = (await uncommittedPaths(workPath)).every(
          (p) => config.worktree.copyFiles.includes(p) || isToolchainOutput(p) || isToolchainDir(p),
        );
        await removeWorktree(repo.path, workPath, force || onlyOurs);
      }
      repo.workPath = null;
      results.push({ repoPath: repo.path, workPath, removed: true });
    } catch (err) {
      results.push({ repoPath: repo.path, workPath, removed: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // The port block is held only while the run has worktrees.
  if (!record.repos.some((r) => r.workPath)) record.ports = null;
  return results;
}
