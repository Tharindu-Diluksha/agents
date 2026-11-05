import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StackId } from "../stacks.js";
import { runCmd } from "./git.js";

/*
 * Installs a fresh worktree's dependencies for each of the repo's stacks,
 * using the tool its lock/manifest files imply. Returns a short description
 * of what ran (empty when there was nothing to install).
 */

export type InstallStep = { cmd: string; args: string[] };

const isWin = process.platform === "win32";

/** Path of a tool inside the worktree's `.venv`. */
export function venvBin(dir: string, tool: string): string {
  return join(dir, ".venv", isWin ? "Scripts" : "bin", isWin ? `${tool}.exe` : tool);
}

export function installSteps(dir: string, stacks: StackId[]): InstallStep[] {
  const has = (f: string) => existsSync(join(dir, f));
  const steps: InstallStep[] = [];
  const set = new Set(stacks);

  if (["typescript", "node", "vue", "react"].some((s) => set.has(s as StackId)) && has("package.json")) {
    if (has("pnpm-lock.yaml")) steps.push({ cmd: "pnpm", args: ["install", "--frozen-lockfile"] });
    else if (has("yarn.lock")) steps.push({ cmd: "yarn", args: ["install", "--frozen-lockfile"] });
    else if (has("package-lock.json")) steps.push({ cmd: "npm", args: ["ci"] });
    else steps.push({ cmd: "npm", args: ["install"] });
  }

  if (set.has("dotnet")) steps.push({ cmd: "dotnet", args: ["restore"] });

  if (set.has("python")) {
    if (has("uv.lock")) steps.push({ cmd: "uv", args: ["sync"] });
    else if (has("poetry.lock")) steps.push({ cmd: "poetry", args: ["install"] });
    else if (has("Pipfile.lock") || has("Pipfile")) steps.push({ cmd: "pipenv", args: ["install", "--dev"] });
    else {
      const reqs = readdirSafe(dir).filter((f) => /^(dev-)?requirements([\w.-]*)?\.txt$/.test(f)).sort((a, b) => (a === "requirements.txt" ? -1 : b === "requirements.txt" ? 1 : a.localeCompare(b)));
      if (reqs.length > 0 || has("pyproject.toml") || has("setup.py")) {
        steps.push({ cmd: isWin ? "python" : "python3", args: ["-m", "venv", ".venv"] });
        const pip = venvBin(dir, "pip");
        for (const r of reqs) steps.push({ cmd: pip, args: ["install", "-r", r] });
        if (reqs.length === 0) steps.push({ cmd: pip, args: ["install", "-e", "."] });
      }
    }
  }

  if (set.has("go") && has("go.mod")) steps.push({ cmd: "go", args: ["mod", "download"] });
  return steps;
}

export async function installDependencies(dir: string, stacks: StackId[], timeoutMs = 15 * 60_000): Promise<string> {
  const ran: string[] = [];
  for (const step of installSteps(dir, stacks)) {
    const label = `${step.cmd.startsWith(dir) ? step.cmd.slice(dir.length + 1) : step.cmd} ${step.args.join(" ")}`;
    const r = await runCmd(step.cmd, step.args, dir, { timeoutMs });
    if (r.code !== 0) {
      const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-15).join("\n");
      const hint = r.code === -1 && /ENOENT/.test(r.stderr) ? ` (is \`${step.cmd}\` installed and on PATH?)` : "";
      throw new Error(`\`${label}\` failed in ${dir} (exit ${r.code})${hint}:\n${tail}`);
    }
    ran.push(label);
  }
  return ran.join("; ");
}

/** Kept for callers that only need the Node command (and the tests). */
export function installCommand(dir: string): string[] | null {
  const node = installSteps(dir, ["typescript"])[0];
  return node ? [node.cmd, ...node.args] : null;
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
