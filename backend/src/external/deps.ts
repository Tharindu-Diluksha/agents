import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCmd } from "./git.js";

/**
 * Installs a fresh worktree's dependencies with the package manager its
 * lockfile implies. Returns the command run, or null when there is nothing
 * to install (no package.json).
 */
export async function installDependencies(dir: string, timeoutMs = 15 * 60_000): Promise<string | null> {
  const cmd = installCommand(dir);
  if (!cmd) return null;
  const r = await runCmd(cmd[0]!, cmd.slice(1), dir, { timeoutMs });
  if (r.code !== 0) {
    const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-15).join("\n");
    throw new Error(`\`${cmd.join(" ")}\` failed in ${dir} (exit ${r.code}):\n${tail}`);
  }
  return cmd.join(" ");
}

export function installCommand(dir: string): string[] | null {
  if (!existsSync(join(dir, "package.json"))) return null;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return ["pnpm", "install", "--frozen-lockfile"];
  if (existsSync(join(dir, "yarn.lock"))) return ["yarn", "install", "--frozen-lockfile"];
  if (existsSync(join(dir, "package-lock.json"))) return ["npm", "ci"];
  return ["npm", "install"];
}
