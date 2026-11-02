import { spawn } from "node:child_process";

export interface RunCmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCmd(cmd: string, args: string[], cwd: string): Promise<RunCmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
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
