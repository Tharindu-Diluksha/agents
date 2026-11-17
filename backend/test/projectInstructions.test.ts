import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectInstructionFiles,
  instructionFileProblem,
  projectInstructionsSection,
  resolveInstructionFiles,
} from "../src/orchestrator/projectInstructions.js";
import type { RepoTarget, RunRecord } from "../src/orchestrator/types.js";

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "instr-"));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function record(repos: Partial<RepoTarget>[]): RunRecord {
  return {
    repos: repos.map((r) => ({ path: "/none", baseBranch: "main", aiGuidelinePath: null, ...r })),
  } as unknown as RunRecord;
}

describe("detectInstructionFiles", () => {
  it("finds the default files at the repo root", () => {
    const dir = repo({ "CLAUDE.md": "a", "AGENTS.md": "b", "docs/CLAUDE.md": "nested, not a default" });
    expect(detectInstructionFiles(dir)).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(detectInstructionFiles(repo({}))).toEqual([]);
  });
});

describe("instructionFileProblem", () => {
  it("accepts repo-relative paths only", () => {
    expect(instructionFileProblem("docs/AI.md")).toBeNull();
    expect(instructionFileProblem("../other/CLAUDE.md")).toMatch(/inside the repo/);
    expect(instructionFileProblem("/etc/passwd")).toMatch(/relative/);
    expect(instructionFileProblem("C:\\x\\CLAUDE.md")).toMatch(/relative/);
  });
});

describe("resolveInstructionFiles", () => {
  it("reads from the worktree, falls back to the checkout for uncommitted files, and honours []", () => {
    const checkout = repo({ "CLAUDE.md": "checkout", "AGENTS.md": "untracked" });
    const worktree = repo({ "CLAUDE.md": "worktree" });
    const r: RepoTarget = { path: checkout, workPath: worktree, baseBranch: "main", aiGuidelinePath: null };
    expect(resolveInstructionFiles(r)).toEqual([
      { file: "CLAUDE.md", abs: join(worktree, "CLAUDE.md") },
      { file: "AGENTS.md", abs: join(checkout, "AGENTS.md") },
    ]);
    expect(resolveInstructionFiles({ ...r, instructionFiles: [] })).toEqual([]);
    expect(resolveInstructionFiles({ ...r, instructionFiles: ["../x.md", "missing.md"] })).toEqual([]);
  });
});

describe("projectInstructionsSection", () => {
  it("inlines the files for the analyst, developer, testers and reviewer only", () => {
    const dir = repo({ "CLAUDE.md": "Use pnpm.\n\n```sh\npnpm test\n```" });
    const rec = record([{ path: dir, instructionFiles: ["CLAUDE.md"] }]);
    for (const role of ["analyst", "developer", "unitTester", "integrationTester", "reviewer"] as const) {
      const s = projectInstructionsSection(rec, role);
      expect(s).toContain("## Project instructions");
      expect(s).toContain("Use pnpm.");
      expect(s).toContain("This prompt decides the workflow");
    }
    // The file's own code fence survives inside a longer fence.
    expect(projectInstructionsSection(rec, "developer")).toContain("````markdown\nUse pnpm.");
    expect(projectInstructionsSection(rec, "e2eTester")).toBe("");
    expect(projectInstructionsSection(rec, "prCreator")).toBe("");
  });

  it("is empty when no repo has instruction files", () => {
    expect(projectInstructionsSection(record([{ path: repo({}) }]), "developer")).toBe("");
    expect(projectInstructionsSection(record([{ path: repo({ "CLAUDE.md": "x" }), instructionFiles: [] }]), "developer")).toBe("");
  });

  it("references a file that is too long instead of inlining it", () => {
    const dir = repo({ "CLAUDE.md": "x".repeat(20_000) });
    const s = projectInstructionsSection(record([{ path: dir }]), "reviewer");
    expect(s).toContain(`Read \`${join(dir, "CLAUDE.md")}\``);
    expect(s).not.toContain("x".repeat(100));
  });
});
