import { spawn } from "node:child_process";

export interface RunCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCmd(cmd: string, args: string[], cwd: string, opts: { timeoutMs?: number } = {}): Promise<RunCmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env, timeout: opts.timeoutMs });
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
