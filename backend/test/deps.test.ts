import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installCommand } from "../src/external/deps.js";

const root = mkdtempSync(join(tmpdir(), "deps-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function dirWith(name: string, files: string[]): string {
  const d = join(root, name);
  mkdirSync(d);
  for (const f of files) writeFileSync(join(d, f), "{}");
  return d;
}

describe("installCommand", () => {
  it("picks the package manager from the lockfile", () => {
    expect(installCommand(dirWith("none", []))).toBeNull();
    expect(installCommand(dirWith("npm", ["package.json", "package-lock.json"]))).toEqual(["npm", "ci"]);
    expect(installCommand(dirWith("pnpm", ["package.json", "pnpm-lock.yaml"]))).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    expect(installCommand(dirWith("yarn", ["package.json", "yarn.lock"]))).toEqual(["yarn", "install", "--frozen-lockfile"]);
    expect(installCommand(dirWith("bare", ["package.json"]))).toEqual(["npm", "install"]);
  });
});
