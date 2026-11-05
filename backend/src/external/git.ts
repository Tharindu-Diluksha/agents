import { spawn } from "node:child_process";

export interface RunCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<RunCmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: { ...process.env, ...opts.env }, timeout: opts.timeoutMs });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message });
    });
  });
}

export async function currentBranch(repoPath: string): Promise<string> {
  const r = await runCmd("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoPath);
  if (r.code !== 0) throw new Error(`git rev-parse failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

export async function pushBranch(repoPath: string, branch: string): Promise<void> {
  const r = await runCmd("git", ["push", "-u", "origin", branch], repoPath);
  if (r.code !== 0) throw new Error(`git push failed: ${r.stderr.trim()}`);
}

export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const r = await runCmd("git", ["status", "--porcelain"], repoPath);
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
  return r.stdout.trim() === "";
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  const r = await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoPath);
  return r.code === 0;
}

/**
 * Safely puts the repo on `branch`, creating it off `baseBranch` if it does
 * not exist. Fails if the working tree is dirty. Does not fetch or pull.
 * Only used by runs created before per-run worktrees (`workspace: "in-place"`).
 */
export async function checkoutOrCreateBranch(repoPath: string, branch: string, baseBranch: string): Promise<"created" | "switched" | "already_on"> {
  if (!(await isWorkingTreeClean(repoPath))) {
    throw new Error(`working tree not clean in ${repoPath}; commit or stash before switching branches`);
  }
  const current = await currentBranch(repoPath);
  if (current === branch) return "already_on";
  if (await branchExists(repoPath, branch)) {
    const r = await runCmd("git", ["checkout", branch], repoPath);
    if (r.code !== 0) throw new Error(`git checkout ${branch} failed: ${r.stderr.trim()}`);
    return "switched";
  }
  const r = await runCmd("git", ["checkout", "-b", branch, baseBranch], repoPath);
  if (r.code !== 0) throw new Error(`git checkout -b ${branch} ${baseBranch} failed: ${r.stderr.trim()}`);
  return "created";
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface WorktreeInfo {
  path: string;
  /** Short branch name, or null when detached. */
  branch: string | null;
}

/** All worktrees of the repository that `repoPath` belongs to (main checkout included). */
export async function listWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
  const r = await runCmd("git", ["worktree", "list", "--porcelain"], repoPath);
  if (r.code !== 0) throw new Error(`git worktree list failed: ${r.stderr.trim()}`);
  const out: WorktreeInfo[] = [];
  let cur: WorktreeInfo | null = null;
  for (const line of r.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ") && cur) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Best-effort `git fetch origin <base>`. Returns the ref new worktrees should
 * start from: `origin/<base>` when it exists after the fetch, else `<base>`.
 */
export async function resolveBaseRef(repoPath: string, baseBranch: string, fetch: boolean): Promise<{ ref: string; fetchError?: string }> {
  let fetchError: string | undefined;
  if (fetch) {
    const f = await runCmd("git", ["fetch", "origin", baseBranch], repoPath, { timeoutMs: 120_000 });
    if (f.code !== 0) fetchError = f.stderr.trim() || `exit ${f.code}`;
  }
  const remote = await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${baseBranch}`], repoPath);
  if (remote.code === 0) return { ref: `origin/${baseBranch}`, fetchError };
  const local = await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`], repoPath);
  if (local.code === 0) return { ref: baseBranch, fetchError };
  throw new Error(`base branch ${baseBranch} not found in ${repoPath} (locally or on origin)`);
}

/** True if `dir` is the top level of a git worktree. */
export async function isWorktreeRoot(dir: string): Promise<boolean> {
  const r = await runCmd("git", ["rev-parse", "--show-toplevel"], dir);
  return r.code === 0 && normalize(r.stdout.trim()) === normalize(dir);
}

/** `git worktree add`: detached at `ref` when `branch` is null, otherwise on the existing `branch`. */
export async function addWorktree(repoPath: string, worktreePath: string, opts: { ref: string } | { branch: string }): Promise<void> {
  const args =
    "branch" in opts
      ? ["worktree", "add", worktreePath, opts.branch]
      : ["worktree", "add", "--detach", worktreePath, opts.ref];
  const r = await runCmd("git", args, repoPath);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

/**
 * Switches a worktree to `branch`, creating it at the worktree's current HEAD
 * if it doesn't exist. Git refuses if another worktree has the branch checked out.
 */
export async function switchWorktreeBranch(worktreePath: string, branch: string): Promise<"created" | "switched" | "already_on"> {
  const head = await runCmd("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath);
  if (head.code === 0 && head.stdout.trim() === branch) return "already_on";
  const exists = await branchExists(worktreePath, branch);
  const args = exists ? ["switch", branch] : ["switch", "-c", branch];
  const r = await runCmd("git", args, worktreePath);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return exists ? "switched" : "created";
}

/** Paths with uncommitted changes (tracked or untracked) in a worktree, from `git status --porcelain`. */
export async function uncommittedPaths(worktreePath: string): Promise<string[]> {
  const r = await runCmd("git", ["status", "--porcelain"], worktreePath);
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
  return r.stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!.trim());
}

/** `git worktree remove` (with `--force` to discard uncommitted changes), then prune. */
export async function removeWorktree(repoPath: string, worktreePath: string, force: boolean): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath];
  const r = await runCmd("git", args, repoPath);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  await runCmd("git", ["worktree", "prune"], repoPath);
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Change tracking and syncing with the base branch
// ---------------------------------------------------------------------------

/**
 * Files this worktree changes relative to where it branched from `baseRef`:
 * committed and uncommitted changes to tracked files, plus untracked files.
 */
export async function changedFiles(worktreePath: string, baseRef: string): Promise<string[]> {
  const mb = await runCmd("git", ["merge-base", baseRef, "HEAD"], worktreePath);
  if (mb.code !== 0) throw new Error(`git merge-base ${baseRef} HEAD failed: ${mb.stderr.trim()}`);
  const diff = await runCmd("git", ["diff", "--name-only", mb.stdout.trim()], worktreePath);
  if (diff.code !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const untracked = await runCmd("git", ["ls-files", "--others", "--exclude-standard"], worktreePath);
  const tracked = diff.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  // Untracked dependency/build output (an un-ignored .venv, bin/obj…) isn't the run's work.
  const added = (untracked.code === 0 ? untracked.stdout.split("\n") : []).map((f) => f.trim()).filter((f) => f && !isToolchainOutput(f));
  const files = [...tracked, ...added];
  return [...new Set(files)].sort();
}

/**
 * Dependency/build output directories (a venv, node_modules, .NET bin/obj…).
 * Untracked files under them aren't a run's changes even when a repo forgot
 * to .gitignore them.
 */
const TOOLCHAIN_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", "bin", "obj", ".gradle", "dist", "coverage", "playwright-report", "test-results"]);
export function isToolchainOutput(path: string): boolean {
  return path.split(/[\\/]/).slice(0, -1).some((seg) => TOOLCHAIN_DIRS.has(seg));
}

export type SyncResult =
  | { status: "up_to_date"; ref: string }
  | { status: "rebased" | "merged"; ref: string; behind: number }
  | { status: "conflicts"; ref: string; behind: number; files: string[] }
  | { status: "skipped"; ref?: string; reason: string };

/**
 * Brings the worktree's branch up to date with the latest base.
 * - Not yet pushed: rebase onto the base (clean history).
 * - Already pushed (origin/<branch> exists): merge, so the next push needs no force.
 * - If a rebase conflicts it is aborted and a merge is attempted instead; a
 *   conflicting merge is LEFT IN PROGRESS (conflict markers in the files) for
 *   the Developer to resolve and commit.
 */
export async function syncWithBase(worktreePath: string, baseBranch: string, opts: { fetch: boolean }): Promise<SyncResult> {
  const { ref, fetchError } = await resolveBaseRef(worktreePath, baseBranch, opts.fetch);
  const branch = (await runCmd("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], worktreePath)).stdout.trim();
  if (!branch) return { status: "skipped", ref, reason: "worktree is not on a branch" };

  const upToDate = await runCmd("git", ["merge-base", "--is-ancestor", ref, "HEAD"], worktreePath);
  if (upToDate.code === 0) return { status: "up_to_date", ref };

  const dirty = await runCmd("git", ["status", "--porcelain", "--untracked-files=no"], worktreePath);
  if (dirty.stdout.trim()) return { status: "skipped", ref, reason: "uncommitted changes in the worktree" };

  const behind = Number((await runCmd("git", ["rev-list", "--count", `HEAD..${ref}`], worktreePath)).stdout.trim()) || 0;
  const pushed = (await runCmd("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], worktreePath)).code === 0;

  if (!pushed) {
    const rebase = await runCmd("git", ["rebase", ref], worktreePath);
    if (rebase.code === 0) return { status: "rebased", ref, behind };
    await runCmd("git", ["rebase", "--abort"], worktreePath);
  }

  const merge = await runCmd("git", ["merge", "--no-edit", ref], worktreePath);
  if (merge.code === 0) return { status: "merged", ref, behind };
  const conflicted = await runCmd("git", ["diff", "--name-only", "--diff-filter=U"], worktreePath);
  const files = conflicted.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) {
    await runCmd("git", ["merge", "--abort"], worktreePath);
    const why = (merge.stderr.trim() || merge.stdout.trim()).split("\n").slice(-3).join(" ");
    return { status: "skipped", ref, reason: `merge failed: ${why}${fetchError ? ` (fetch: ${fetchError})` : ""}` };
  }
  return { status: "conflicts", ref, behind, files };
}

// ---------------------------------------------------------------------------
// Clones for runs launched by Git URL
// ---------------------------------------------------------------------------

/** Never wait for a username/password prompt: fail fast when credentials are missing. */
const NON_INTERACTIVE = { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" };

/** `git clone` into `dir` (which must not exist yet). */
export async function cloneRepo(url: string, dir: string, timeoutMs = 15 * 60_000): Promise<void> {
  const r = await runCmd("git", ["clone", "--no-tags", url, dir], process.cwd(), { timeoutMs, env: NON_INTERACTIVE });
  if (r.code !== 0) throw new Error(`git clone ${url} failed: ${(r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ")}`);
}

/** `git fetch --prune origin` in an existing clone. */
export async function fetchOrigin(dir: string, timeoutMs = 5 * 60_000): Promise<void> {
  const r = await runCmd("git", ["fetch", "--prune", "--no-tags", "origin"], dir, { timeoutMs, env: NON_INTERACTIVE });
  if (r.code !== 0) throw new Error(`git fetch in ${dir} failed: ${(r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ")}`);
}

export async function originUrl(dir: string): Promise<string | null> {
  const r = await runCmd("git", ["remote", "get-url", "origin"], dir);
  return r.code === 0 ? r.stdout.trim() : null;
}
