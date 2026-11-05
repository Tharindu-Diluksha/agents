import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectStacks, STACK_IDS, STACKS, stacksOf } from "../src/stacks.js";
import { installSteps } from "../src/external/deps.js";
import { isToolchainOutput } from "../src/external/git.js";
import { runEnv } from "../src/orchestrator/ports.js";
import { stackSection } from "../src/roles/common.js";
import type { RunRecord } from "../src/orchestrator/types.js";

const root = mkdtempSync(join(tmpdir(), "stacks-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function repo(files: Record<string, string>): string {
  const dir = join(root, `r${++n}`);
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}
const pkg = (deps: Record<string, string>, dev: Record<string, string> = {}) => JSON.stringify({ dependencies: deps, devDependencies: dev });

describe("detectStacks", () => {
  it("tells the Node family apart", () => {
    expect(detectStacks(repo({ "package.json": pkg({ vue: "^3" }, { typescript: "^5" }) }))).toEqual(["vue"]);
    expect(detectStacks(repo({ "package.json": pkg({ react: "^19" }) }))).toEqual(["react"]);
    expect(detectStacks(repo({ "package.json": pkg({ next: "^15" }) }))).toEqual(["react"]);
    expect(detectStacks(repo({ "package.json": pkg({}, { typescript: "^5" }) }))).toEqual(["typescript"]);
    expect(detectStacks(repo({ "package.json": pkg({ express: "^4" }), "tsconfig.json": "{}" }))).toEqual(["typescript"]);
    expect(detectStacks(repo({ "package.json": pkg({ express: "^4" }) }))).toEqual(["node"]);
  });

  it("finds .NET, Python and Go", () => {
    expect(detectStacks(repo({ "App.sln": "" }))).toEqual(["dotnet"]);
    expect(detectStacks(repo({ "src/Api/Api.csproj": "<Project/>" }))).toEqual(["dotnet"]);
    expect(detectStacks(repo({ "pyproject.toml": "" }))).toEqual(["python"]);
    expect(detectStacks(repo({ "requirements-dev.txt": "" }))).toEqual(["python"]);
    expect(detectStacks(repo({ "go.mod": "module x" }))).toEqual(["go"]);
  });

  it("reports every stack of a mixed repo and nothing for an unknown one", () => {
    expect(detectStacks(repo({ "go.mod": "module x", "package.json": pkg({ react: "^19" }) }))).toEqual(["react", "go"]);
    expect(detectStacks(repo({ "README.md": "" }))).toEqual([]);
  });

  it("falls back to TypeScript for runs created before stack profiles", () => {
    expect(stacksOf({})).toEqual(["typescript"]);
    expect(stacksOf({ stacks: ["go"] })).toEqual(["go"]);
  });
});

describe("installSteps", () => {
  const cmds = (dir: string, stacks: Parameters<typeof installSteps>[1]) =>
    installSteps(dir, stacks).map((s) => [s.cmd.replace(dir, "<dir>"), ...s.args].join(" "));

  it("uses the lockfile's package manager for Node stacks", () => {
    expect(cmds(repo({ "package.json": "{}", "pnpm-lock.yaml": "" }), ["vue"])).toEqual(["pnpm install --frozen-lockfile"]);
    expect(cmds(repo({ "package.json": "{}", "package-lock.json": "" }), ["react"])).toEqual(["npm ci"]);
  });

  it("restores .NET, downloads Go modules", () => {
    expect(cmds(repo({ "App.sln": "" }), ["dotnet"])).toEqual(["dotnet restore"]);
    expect(cmds(repo({ "go.mod": "module x" }), ["go"])).toEqual(["go mod download"]);
  });

  it("Python: uv/poetry when locked, else a .venv with the requirements files", () => {
    expect(cmds(repo({ "pyproject.toml": "", "uv.lock": "" }), ["python"])).toEqual(["uv sync"]);
    expect(cmds(repo({ "pyproject.toml": "", "poetry.lock": "" }), ["python"])).toEqual(["poetry install"]);
    const venv = cmds(repo({ "requirements.txt": "", "requirements-dev.txt": "" }), ["python"]);
    expect(venv[0]).toMatch(/^python3? -m venv \.venv$/);
    expect(venv.slice(1)).toEqual([
      expect.stringMatching(/<dir>[\\/]\.venv[\\/](bin|Scripts)[\\/]pip(\.exe)? install -r requirements\.txt/),
      expect.stringMatching(/install -r requirements-dev\.txt$/),
    ]);
    expect(cmds(repo({ "pyproject.toml": "" }), ["python"]).at(-1)).toMatch(/pip(\.exe)? install -e \.$/);
  });

  it("installs every stack of a mixed repo", () => {
    expect(cmds(repo({ "go.mod": "m", "package.json": "{}", "package-lock.json": "" }), ["react", "go"])).toEqual(["npm ci", "go mod download"]);
  });
});

describe("runEnv per stack", () => {
  it("puts a Python worktree's .venv on PATH and sets ASPNETCORE_URLS for .NET", () => {
    const py = repo({ "requirements.txt": "", ".venv/bin/pytest": "", ".venv/Scripts/pytest.exe": "" });
    const env = runEnv({
      runId: "R",
      ports: { base: 41000, count: 10 },
      repos: [
        { path: "/u/py", workPath: py, stacks: ["python"] },
        { path: "/u/api", workPath: "/w/api", stacks: ["dotnet"] },
      ],
    } as unknown as RunRecord);
    expect(env.PATH!.split(/[:;]/)[0]).toMatch(/\.venv[\\/](bin|Scripts)$/);
    expect(env.VIRTUAL_ENV).toBe(join(py, ".venv"));
    expect(env.ASPNETCORE_URLS).toBe("http://localhost:41000");
    expect(env.DOTNET_CLI_TELEMETRY_OPTOUT).toBe("1");
  });
});

describe("isToolchainOutput", () => {
  it("recognises dependency and build output folders", () => {
    for (const f of [".venv/lib/x.py", "node_modules/a/index.js", "src/Api/bin/Debug/Api.dll", "pkg/__pycache__/m.pyc"]) {
      expect(isToolchainOutput(f), f).toBe(true);
    }
    for (const f of ["src/app.ts", "bin.go", "cmd/server/main.go"]) expect(isToolchainOutput(f), f).toBe(false);
  });
});

describe("stackSection", () => {
  it("gives each role the guidance it needs for each repo", () => {
    const record = {
      runId: "R",
      repos: [
        { path: "/u/web", workPath: "/w/web", stacks: ["vue"] },
        { path: "/u/api", stacks: ["dotnet"] },
      ],
    } as unknown as RunRecord;
    const unit = stackSection(record, "unitTester");
    expect(unit).toContain("`/w/web`** — Vue");
    expect(unit).toContain("@vue/test-utils");
    expect(unit).toContain("`/u/api`** — C# / .NET");
    expect(unit).toContain("dotnet test --filter");
    expect(unit).not.toContain("Integration tests:");
    expect(stackSection(record, "integrationTester")).toContain("Integration tests: For ASP.NET Core use `WebApplicationFactory");
    expect(stackSection(record, "e2eTester")).toContain("An existing E2E suite looks like");
    expect(stackSection(record, "reviewer")).toContain("dotnet list package --vulnerable");
    expect(stackSection(record, "analyst")).toBe("");
  });

  it("every profile has complete guidance", () => {
    for (const id of STACK_IDS) {
      const g = STACKS[id].guidance;
      for (const k of ["summary", "unit", "integration", "e2e", "e2eSuite", "review", "ports"] as const) {
        expect(g[k].length, `${id}.${k}`).toBeGreaterThan(20);
      }
      for (const cap of ["test", "lint", "e2e", "install", "inspect"] as const) {
        expect(STACKS[id].bash[cap]?.length ?? 0, `${id}.${cap}`).toBeGreaterThan(0);
      }
    }
  });
});
