import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Stack profiles: what a role may run and how it should test, per tech stack.
 *
 * A repo has one or more stacks (detected from its files at launch, or chosen
 * in the launch dialog), each living in a folder of the repo (`StackProject`):
 * the root, or one level down for monorepos. A role's Bash allowlist is its stack-independent git
 * patterns plus, for every stack of every repo in the run, that stack's
 * patterns for the capabilities the role has (see roles/*.ts `capabilities`).
 * The same profiles drive dependency installation in new worktrees and the
 * "Stack" section injected into role prompts.
 */

export const STACK_IDS = ["typescript", "node", "vue", "react", "angular", "dotnet", "python", "go"] as const;
export type StackId = (typeof STACK_IDS)[number];

/**
 * Where a stack lives inside a repo: `dir` is relative to the repo root, "."
 * for the root itself. A monorepo has several, e.g. `prep-app` (angular) and
 * `prep-api` (dotnet). Roles run that stack's commands from that folder.
 */
export interface StackProject {
  dir: string;
  stack: StackId;
}

/** What a role is allowed to do with the toolchain. */
export type Capability =
  | "test" // run unit/integration tests and typecheck
  | "lint" // static checks (lint, typecheck, format check)
  | "build" // compile/build
  | "audit" // dependency vulnerability audit
  | "e2e" // run end-to-end tests
  | "install" // add/install packages (E2E Tester, only after approval)
  | "inspect"; // read build/manifest files with cat

export interface StackGuidance {
  /** One line: test frameworks and commands to prefer. */
  summary: string;
  unit: string;
  integration: string;
  e2e: string;
  /** How to recognise an existing E2E suite. */
  e2eSuite: string;
  review: string;
  /**
   * Compiled languages only: how RED-phase unit tests fail at run time when the
   * code under test doesn't exist yet (a missing type breaks the whole test build).
   */
  unitRed?: string;
  /** How a server under test picks its port (the run's ports come as env vars). */
  ports: string;
}

export interface StackProfile {
  id: StackId;
  label: string;
  bash: Partial<Record<Capability, RegExp[]>>;
  /** Typical commands per capability, shown to the roles (each matches `bash`). */
  examples: Partial<Record<Exclude<Capability, "inspect">, string[]>>;
  guidance: StackGuidance;
}

// ---------------------------------------------------------------------------
// Node family (TypeScript, JavaScript, Vue, React) share the toolchain.
// ---------------------------------------------------------------------------

const PM = "(?:npm|pnpm|yarn)";
const NODE_BASH: Partial<Record<Capability, RegExp[]>> = {
  test: [
    new RegExp(`^${PM}\\s+(test|run\\s+(test|typecheck|lint)(:\\S+)?)(\\s|$)`),
    /^yarn\s+(test|typecheck|lint)(:\S+)?(\s|$)/,
    /^npx\s+(vitest|jest|tsc|vue-tsc)(\s|$)/,
    /^(pnpm|yarn)\s+(exec\s+)?(vitest|jest|tsc|vue-tsc)(\s|$)/,
    /^node\s+--test(\s|$)/,
    /^node\s+(--version|-v)$/,
  ],
  lint: [
    new RegExp(`^${PM}\\s+(run\\s+)?(lint|typecheck|format:check)(:\\S+)?(\\s|$)`),
    /^npx\s+(eslint|tsc|vue-tsc)(\s|$)/,
    /^npx\s+prettier\s+--check(\s|$)/,
  ],
  build: [new RegExp(`^${PM}\\s+(run\\s+)?build(:\\S+)?(\\s|$)`)],
  audit: [new RegExp(`^${PM}\\s+audit(\\s|$)`)],
  e2e: [
    new RegExp(`^${PM}\\s+(run\\s+)?(e2e|playwright|test:e2e)(:\\S+)?(\\s|$)`),
    // Running Playwright, but not `playwright install` (that is an install, gated by approval).
    /^npx\s+playwright\s+(?!install\b)/,
    /^npm\s+exec\s+playwright\s+(?!install\b)/,
    /^(pnpm\s+exec|yarn)\s+playwright\s+(?!install\b)/,
  ],
  install: [
    new RegExp(`^${PM}\\s+(install|i|add|ci)(\\s|$)`),
    /^npx\s+playwright\s+install(\s|$)/,
    /^npm\s+exec\s+playwright\s+install(\s|$)/,
    /^(pnpm\s+exec|yarn)\s+playwright\s+install(\s|$)/,
  ],
  inspect: [
    /^cat\s+(package\.json|tsconfig[\w.-]*\.json|(playwright|vite|vitest|jest)\.config\.(ts|js|mjs|cjs))$/,
  ],
};

/** A copy of `base` with `extra` patterns appended per capability. */
function withExtra(base: Partial<Record<Capability, RegExp[]>>, extra: Partial<Record<Capability, RegExp[]>>): Partial<Record<Capability, RegExp[]>> {
  const out: Partial<Record<Capability, RegExp[]>> = { ...base };
  for (const [cap, res] of Object.entries(extra) as Array<[Capability, RegExp[]]>) out[cap] = [...(base[cap] ?? []), ...res];
  return out;
}

const nodeExamples = (extraTest: string[] = []): StackProfile["examples"] => ({
  test: ["npm test", "npx vitest run <file>", ...extraTest],
  lint: ["npm run lint", "npm run typecheck"],
  build: ["npm run build"],
  audit: ["npm audit"],
  e2e: ["npx playwright test"],
  install: ["npm install -D @playwright/test", "npx playwright install"],
});

const NODE_E2E = "Playwright (`@playwright/test`): tests under the existing e2e folder, one flow per user-facing AC, stable `data-testid`/role selectors, `webServer` in `playwright.config.*` to start the app.";
const NODE_E2E_SUITE = "a `playwright.config.ts|js|mjs` file (or a `test:e2e`/`e2e` script)";
const NODE_PORTS = "Most Node dev servers read `PORT`; Vite needs `--port $PORT` (or `server.port` from env). Point Playwright's `webServer.port`/`use.baseURL` at `E2E_PORT`/`E2E_BASE_URL`.";

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

const PY = "(?:(?:\\.venv|venv)[\\\\/](?:bin|Scripts)[\\\\/])?";
const PY_RUN = "(?:(?:uv|poetry|pipenv)\\s+run\\s+)?";

export const STACKS: Record<StackId, StackProfile> = {
  typescript: {
    id: "typescript",
    label: "TypeScript (Node)",
    bash: NODE_BASH,
    examples: nodeExamples(["npx tsc --noEmit"]),
    guidance: {
      summary: "Vitest or Jest (whichever the repo uses) for unit tests, `tsc --noEmit`/`npm run typecheck` for types, Playwright for E2E.",
      unit: "Use the repo's runner (Vitest or Jest), co-located `*.test.ts`/`*.spec.ts` or the existing `test/` layout. Type the test code too; `tsc` must stay clean.",
      integration: "Exercise real modules together: e.g. an HTTP app via `supertest` (Express/Fastify `inject`), real service + repository with an in-memory or test database if the repo has one.",
      e2e: NODE_E2E,
      e2eSuite: NODE_E2E_SUITE,
      review: "Run the lint and typecheck scripts; `npm audit` for dependencies. Watch for `any` leaks, unhandled promises, missing input validation at API boundaries.",
      ports: NODE_PORTS,
    },
  },
  node: {
    id: "node",
    label: "Node.js (JavaScript)",
    bash: NODE_BASH,
    examples: nodeExamples(["node --test"]),
    guidance: {
      summary: "The repo's runner (Vitest, Jest, Mocha or `node --test`) for unit tests, Playwright for E2E.",
      unit: "Use the existing runner and layout (`*.test.js`, `test/`). If there is none but Node ≥ 18, `node:test` with `node --test` needs no dependencies.",
      integration: "Exercise real modules together, e.g. HTTP endpoints via `supertest`, real service + data layer with a test database if available.",
      e2e: NODE_E2E,
      e2eSuite: NODE_E2E_SUITE,
      review: "Run the lint script; `npm audit` for dependencies. Watch for unvalidated input, unhandled promise rejections, prototype pollution.",
      ports: NODE_PORTS,
    },
  },
  vue: {
    id: "vue",
    label: "Vue",
    bash: NODE_BASH,
    examples: nodeExamples(["npx vue-tsc --noEmit"]),
    guidance: {
      summary: "Vitest + `@vue/test-utils` for component/unit tests, `vue-tsc --noEmit` for types, Playwright for E2E.",
      unit: "Vitest + `@vue/test-utils`: `mount`/`shallowMount`, find by `data-testid` or role, assert rendered output and emitted events, not internals. For Pinia stores use `createTestingPinia` or a fresh `setActivePinia(createPinia())`.",
      integration: "Mount pages/feature components with the real router and store, stubbing only the network (MSW or the repo's API mock). If the repo has a backend in the same run, test the API there.",
      e2e: NODE_E2E,
      e2eSuite: NODE_E2E_SUITE,
      review: "Run `vue-tsc`/typecheck and lint. Watch for `v-html` with untrusted data (XSS), reactivity loss from destructuring, missing `key` on `v-for`, watchers without cleanup.",
      ports: "Start Vite with `--port $PORT --strictPort`. Point Playwright's `webServer`/`baseURL` at `E2E_PORT`/`E2E_BASE_URL`.",
    },
  },
  react: {
    id: "react",
    label: "React",
    bash: NODE_BASH,
    examples: nodeExamples(),
    guidance: {
      summary: "Vitest or Jest + React Testing Library for unit/component tests, Playwright for E2E.",
      unit: "React Testing Library: render, query by role/label/text (`getByRole`), drive with `userEvent`, assert what the user sees. Don't test hooks' internals or component state directly; test hooks with `renderHook` only when they are the unit.",
      integration: "Render routes/feature trees with real providers (router, store, query client), mocking only the network (MSW or the repo's mocks). If the repo has a backend in the same run, test the API there.",
      e2e: NODE_E2E,
      e2eSuite: NODE_E2E_SUITE,
      review: "Run lint (incl. `react-hooks` rules) and typecheck. Watch for `dangerouslySetInnerHTML` with untrusted data, stale closures in effects, missing effect cleanup, unstable `key`s.",
      ports: "Vite: `--port $PORT --strictPort`; CRA/Next read `PORT`. Point Playwright's `webServer`/`baseURL` at `E2E_PORT`/`E2E_BASE_URL`.",
    },
  },
  angular: {
    id: "angular",
    label: "Angular",
    bash: withExtra(NODE_BASH, {
      // `ng test` watches by default and would never return: require --watch=false / --no-watch.
      test: [/^(npx\s+)?ng\s+test\s+(\S+\s+)*--(watch=false|no-watch)(\s|$)/, /^(npx\s+)?ng\s+(build|version)(\s|$)/],
      lint: [/^(npx\s+)?ng\s+lint(\s|$)/],
      build: [/^(npx\s+)?ng\s+build(\s|$)/],
      e2e: [/^(npx\s+)?ng\s+e2e(\s|$)/],
      inspect: [/^cat\s+angular\.json$/, /^cat\s+karma\.conf\.(js|cjs|ts)$/],
    }),
    examples: {
      test: ["npx ng test --watch=false --browsers=ChromeHeadless", "npm test -- --watch=false --browsers=ChromeHeadless", "npx tsc --noEmit -p tsconfig.app.json"],
      lint: ["npx ng lint", "npx tsc --noEmit -p tsconfig.app.json"],
      build: ["npx ng build"],
      audit: ["npm audit"],
      e2e: ["npx playwright test"],
      install: ["npm install -D @playwright/test", "npx playwright install"],
    },
    guidance: {
      summary: "The workspace's `ng test` runner (Karma + Jasmine by default; Jest or Vitest if `angular.json` says so), always with `--watch=false`; `ng build` for compile errors; Playwright for E2E.",
      unit: "`*.spec.ts` next to the code, using `TestBed` with the standalone component/service under test in `imports`/`providers`; `HttpTestingController` (`provideHttpClientTesting()`) for HTTP, `RouterTestingHarness` or `provideRouter([])` for routing. Query the DOM via `fixture.nativeElement`/`By.css` and assert what the user sees. Run with `ng test --watch=false` (add `--browsers=ChromeHeadless` for Karma) — without it the runner never exits.",
      integration: "Test feature routes with the real router and guards (`RouterTestingHarness`), real services and `HttpTestingController` stubbing only the network. If the backend is in the same run (another folder or repo), test its API there.",
      e2e: NODE_E2E,
      e2eSuite: NODE_E2E_SUITE + ", or an `e2e` target in `angular.json`",
      review: "Run `ng build` (new template/type errors are findings) and `ng lint` if configured; `npm audit`. Watch for `bypassSecurityTrust*`/`[innerHTML]` with untrusted data, subscriptions without `takeUntilDestroyed`/`async` pipe, route guards that only hide UI (the API must enforce access too), lazy routes that don't split admin-only code.",
      ports: "Start the dev server with `npx ng serve --port $PORT`. Point Playwright's `webServer`/`baseURL` at `E2E_PORT`/`E2E_BASE_URL`.",
    },
  },
  dotnet: {
    id: "dotnet",
    label: "C# / .NET",
    bash: {
      test: [/^dotnet\s+test(\s|$)/, /^dotnet\s+build(\s|$)/, /^dotnet\s+--(version|info)$/],
      lint: [/^dotnet\s+format\s+(\S+\s+)*--verify-no-changes(\s|$)/, /^dotnet\s+build(\s|$)/],
      build: [/^dotnet\s+(build|restore)(\s|$)/],
      audit: [/^dotnet\s+list\s+(\S+\s+)?package\s+--vulnerable(\s|$)/],
      e2e: [/^dotnet\s+test(\s|$)/],
      install: [/^dotnet\s+add\s+(\S+\s+)?package(\s|$)/, /^dotnet\s+tool\s+restore(\s|$)/, /^pwsh\s+\S*playwright\.ps1\s+install(\s|$)/],
      inspect: [/^cat\s+[\w./\\-]+\.(csproj|fsproj|sln|props|targets)$/, /^cat\s+(global\.json|nuget\.config|NuGet\.Config|appsettings[\w.-]*\.json)$/],
    },
    examples: {
      test: ["dotnet test", "dotnet test tests/App.Tests/App.Tests.csproj --nologo --filter \"FullyQualifiedName~Orders\""],
      lint: ["dotnet build", "dotnet format --verify-no-changes"],
      build: ["dotnet build"],
      audit: ["dotnet list package --vulnerable"],
      e2e: ["dotnet test <E2E test project>"],
      install: ["dotnet add <project> package Microsoft.Playwright.NUnit", "pwsh bin/Debug/<tfm>/playwright.ps1 install"],
    },
    guidance: {
      summary: "xUnit, NUnit or MSTest (whichever test projects use) via `dotnet test`, `WebApplicationFactory` for integration, Microsoft.Playwright for E2E.",
      unit: "Add tests to the existing `*.Tests` project for the code under test (same framework and assertion library: xUnit `[Fact]/[Theory]`, NUnit `[Test]`, MSTest `[TestMethod]`). Only create a new test project if none exists, mirroring the solution's conventions. While working, build and test only the test project you changed (`dotnet test <path>.csproj --nologo --filter …`); run the whole solution once at the end. A test-project build also builds the projects it references, so a separate `dotnet build` first is rarely needed.",
      unitRed: "A test that refers to a type or member that doesn't exist yet stops the whole test project from compiling, so no test runs. Add only the compile-only stubs the new tests need in production code: new types, members, parameters or DTO properties with the planned signatures, whose bodies `throw new NotImplementedException()` (properties may be plain auto-properties). No logic. The new tests then fail when they run, and existing tests keep compiling and passing.",
      integration: "For ASP.NET Core use `WebApplicationFactory<Program>` (Microsoft.AspNetCore.Mvc.Testing) and call real endpoints with its `HttpClient`; use Testcontainers or the repo's test database setup only if it already exists, otherwise mark DB-dependent tests env-missing.",
      e2e: "Microsoft.Playwright with the repo's test framework (e.g. `Microsoft.Playwright.NUnit`/`.MSTest`/xUnit fixture) in a dedicated E2E test project, run via `dotnet test`. Browsers install with `pwsh bin/<Configuration>/<tfm>/playwright.ps1 install`.",
      e2eSuite: "a test project referencing `Microsoft.Playwright` (check the `*.csproj` files)",
      review: "Run `dotnet build` (treat new warnings as findings), `dotnet format --verify-no-changes` if the repo uses it, `dotnet list package --vulnerable`. Watch for missing `await`/`async void`, `IDisposable` leaks, SQL built by string concatenation, missing `[Authorize]`, nullable warnings.",
      ports: "Run the app with `ASPNETCORE_URLS` (already set to the run's base port) or `dotnet run --urls $E2E_BASE_URL`.",
    },
  },
  python: {
    id: "python",
    label: "Python",
    bash: {
      test: [
        new RegExp(`^${PY_RUN}${PY}(python3?\\s+-m\\s+)?pytest(\\s|$)`),
        new RegExp(`^${PY_RUN}${PY}python3?\\s+-m\\s+unittest(\\s|$)`),
        new RegExp(`^${PY}python3?\\s+--version$`),
      ],
      lint: [
        new RegExp(`^${PY_RUN}${PY}(python3?\\s+-m\\s+)?(ruff\\s+(check|format\\s+--check)|mypy|pyright|flake8|black\\s+--check|isort\\s+--check(-only)?)(\\s|$)`),
      ],
      build: [new RegExp(`^${PY_RUN}${PY}python3?\\s+-m\\s+(build|compileall)(\\s|$)`)],
      audit: [new RegExp(`^${PY_RUN}${PY}(python3?\\s+-m\\s+)?pip-audit(\\s|$)`)],
      e2e: [new RegExp(`^${PY_RUN}${PY}(python3?\\s+-m\\s+)?pytest(\\s|$)`)],
      install: [
        new RegExp(`^${PY}(python3?\\s+-m\\s+)?pip\\s+install(\\s|$)`),
        /^uv\s+(add|sync|pip\s+install)(\s|$)/,
        /^poetry\s+(add|install)(\s|$)/,
        new RegExp(`^${PY_RUN}${PY}(python3?\\s+-m\\s+)?playwright\\s+install(\\s|$)`),
      ],
      inspect: [/^cat\s+(pyproject\.toml|requirements[\w.-]*\.txt|setup\.(cfg|py)|pytest\.ini|tox\.ini|Pipfile|conftest\.py|manage\.py)$/],
    },
    examples: {
      test: ["pytest -q", "python -m pytest tests/unit -k <name>"],
      lint: ["ruff check .", "mypy <package>"],
      build: ["python -m compileall -q <package>"],
      audit: ["pip-audit"],
      e2e: ["pytest tests/e2e"],
      install: ["pip install pytest-playwright", "python -m playwright install"],
    },
    guidance: {
      summary: "pytest (or the repo's `unittest` suite), run inside the run's virtualenv; pytest-playwright for E2E.",
      unit: "pytest: `tests/` (or the existing layout), `test_*.py`, plain `assert`, fixtures in `conftest.py`, `pytest.mark.parametrize` for cases. Keep the repo's style if it uses `unittest`. The run's `.venv` is on PATH, so `pytest` / `python -m pytest` use the project's dependencies.",
      integration: "Use the framework's test client against the real app: FastAPI `TestClient`/`httpx.AsyncClient`, Flask `app.test_client()`, Django `TestCase` + `Client`. Use the repo's test database setup if it exists (e.g. SQLite or Django's test DB); otherwise mark external-service tests env-missing.",
      e2e: "pytest-playwright (`page` fixture) in an `e2e`/`tests/e2e` folder, run with `pytest`. Browsers install with `python -m playwright install`.",
      e2eSuite: "tests using the `page` fixture from `pytest-playwright` (check dev dependencies and `tests/e2e`)",
      review: "Run the configured linters (ruff, mypy/pyright, flake8/black) and `pip-audit` if available. Watch for SQL/command injection (f-strings into queries or `subprocess` with `shell=True`), unsafe `pickle`/`yaml.load`, mutable default arguments, broad `except:`.",
      ports: "Start servers on `$PORT`: `uvicorn app:app --port $PORT`, `flask run --port $PORT`, `python manage.py runserver $PORT`.",
    },
  },
  go: {
    id: "go",
    label: "Go",
    bash: {
      test: [/^go\s+(test|vet)(\s|$)/, /^go\s+version$/],
      lint: [/^go\s+vet(\s|$)/, /^gofmt\s+-l(\s|$)/, /^golangci-lint\s+run(\s|$)/, /^staticcheck(\s|$)/],
      build: [/^go\s+build(\s|$)/],
      audit: [/^govulncheck(\s|$)/],
      e2e: [/^go\s+test(\s|$)/],
      install: [/^go\s+(get|mod\s+(download|tidy))(\s|$)/],
      inspect: [/^cat\s+(go\.mod|go\.sum|Makefile|\.golangci\.ya?ml)$/],
    },
    examples: {
      test: ["go test ./...", "go test ./<pkg> -run <TestName>"],
      lint: ["go vet ./...", "gofmt -l .", "golangci-lint run"],
      build: ["go build ./..."],
      audit: ["govulncheck ./..."],
      e2e: ["go test -tags e2e ./..."],
      install: ["go get <module>"],
    },
    guidance: {
      summary: "`go test ./...` with table-driven tests, `httptest` for integration, `go vet`/golangci-lint for checks.",
      unit: "`_test.go` files next to the code (same package, or `_test` package for black-box tests), table-driven `t.Run` subtests, the standard `testing` package plus whatever assertion library the repo already uses. Run one test with `go test ./pkg/... -run TestName`.",
      unitRed: "Go won't compile a package whose tests refer to a missing function, type or field, so none of that package's tests run. Add only the compile-only stubs the new tests need: the planned declarations with bodies that `panic(\"not implemented\")` (struct fields as declared). No logic.",
      integration: "Use `httptest.NewServer`/`httptest.NewRecorder` against the real handlers and services; guard tests that need external services with a build tag or `testing.Short()` and mark them env-missing.",
      e2e: "If the repo (or another repo in this run) has a Playwright setup, use it against the Go server. Otherwise write Go tests behind an `e2e` build tag that start the server on `$PORT` and drive it over HTTP (`go test -tags e2e ./...`).",
      e2eSuite: "a Playwright config in the repo or a sibling frontend, or tests behind an `e2e` build tag",
      review: "Run `go vet`, `gofmt -l`, `golangci-lint run` if configured, `govulncheck` if installed. Watch for unchecked errors, goroutine leaks, data races (suggest `go test -race`), missing `defer Close()`, context not propagated.",
      ports: "Have the server read `PORT` (or pass a `-addr :$PORT` flag).",
    },
  },
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Folders never searched for projects (dependencies, build output, tooling). */
const SKIP_DIRS = new Set(["node_modules", "bin", "obj", "dist", "build", "out", "target", "vendor", "coverage", "venv", "__pycache__"]);

/** Stacks whose marker files sit directly in `dir` (plus .NET projects under src/, tests/, test/). */
function stacksIn(dir: string): StackId[] {
  const out: StackId[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  const root = listSafe(dir);

  const pkg = has("package.json") ? readJson(join(dir, "package.json")) : null;
  if (pkg) {
    const deps = { ...((pkg.dependencies as object) ?? {}), ...((pkg.devDependencies as object) ?? {}) } as Record<string, unknown>;
    if ("@angular/core" in deps || has("angular.json")) out.push("angular");
    else if ("vue" in deps || "nuxt" in deps) out.push("vue");
    else if ("react" in deps || "next" in deps) out.push("react");
    else if ("typescript" in deps || has("tsconfig.json")) out.push("typescript");
    else out.push("node");
  }

  const isDotnet = (f: string) => /\.(sln|slnx|csproj|fsproj)$/i.test(f);
  if (root.some(isDotnet) || ["src", "tests", "test"].some((d) => listSafe(join(dir, d)).some((sub) => listSafe(join(dir, d, sub)).some(isDotnet)))) {
    out.push("dotnet");
  }

  if (["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg", "Pipfile"].some(has) || root.some((f) => /^requirements[\w.-]*\.txt$/.test(f))) {
    out.push("python");
  }

  if (has("go.mod")) out.push("go");
  return out;
}

/**
 * Projects of the repo at `dir`: stacks at the root, then stacks in each
 * top-level folder (monorepos such as `web/` + `api/`). A stack already found
 * at the root isn't repeated for sub-folders (a root .sln already covers its
 * projects; a root package.json usually drives its workspaces).
 */
export function detectProjects(dir: string): StackProject[] {
  const out: StackProject[] = stacksIn(dir).map((stack) => ({ dir: ".", stack }));
  const atRoot = new Set(out.map((p) => p.stack));
  const subdirs = listSafe(dir)
    .filter((d) => !d.startsWith(".") && !SKIP_DIRS.has(d.toLowerCase()))
    .filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  for (const sub of subdirs) {
    for (const stack of stacksIn(join(dir, sub))) {
      if (!atRoot.has(stack)) out.push({ dir: sub, stack });
    }
  }
  return out;
}

/** Stacks of the repo at `dir` (root and top-level folders), in detection order. [] when nothing is recognised. */
export function detectStacks(dir: string): StackId[] {
  return [...new Set(detectProjects(dir).map((p) => p.stack))];
}

/**
 * Projects for a repo given the stacks the user chose: the detected folders of
 * each chosen stack, and the repo root for a chosen stack nothing was detected for.
 */
export function projectsFor(chosen: StackId[], detected: StackProject[]): StackProject[] {
  const out: StackProject[] = [];
  for (const stack of new Set(chosen)) {
    const found = detected.filter((p) => p.stack === stack);
    out.push(...(found.length > 0 ? found : [{ dir: ".", stack }]));
  }
  return out;
}

/** The repo's projects; runs created before monorepo support have every stack at the root. */
export function projectsOf(repo: { stacks?: StackId[] | null; projects?: StackProject[] | null }): StackProject[] {
  if (repo.projects && repo.projects.length > 0) return repo.projects;
  return stacksOf(repo).map((stack) => ({ dir: ".", stack }));
}

/** The repo's stacks, falling back to TypeScript for runs created before stack profiles. */
export function stacksOf(repo: { stacks?: StackId[] | null }): StackId[] {
  return repo.stacks && repo.stacks.length > 0 ? repo.stacks : ["typescript"];
}

export function isStackId(v: unknown): v is StackId {
  return typeof v === "string" && (STACK_IDS as readonly string[]).includes(v);
}

/** Union of the patterns the given stacks provide for the given capabilities. */
export function stackBashPatterns(stacks: Iterable<StackId>, capabilities: Iterable<Capability>): RegExp[] {
  const caps = [...capabilities];
  const out: RegExp[] = [];
  const seen = new Set<string>();
  for (const id of new Set(stacks)) {
    for (const cap of caps) {
      for (const re of STACKS[id].bash[cap] ?? []) {
        if (seen.has(re.source)) continue;
        seen.add(re.source);
        out.push(re);
      }
    }
  }
  return out;
}

/** Human-readable detection rules (mirrors detectStacks), for docs and the plugin's stack guide. */
export const DETECTION_RULES: string[] = [
  "Check the repo root and each top-level folder (skipping dot-folders, `node_modules`, `bin`, `obj`, `dist` and other output folders); a monorepo such as `web/` + `api/` has one stack per folder, and commands for that stack run from its folder",
  "`package.json` depending on `@angular/core` (or an `angular.json`) → **angular**; on `vue`/`nuxt` → **vue**; on `react`/`next` → **react**; on `typescript` or with a `tsconfig.json` → **typescript**; otherwise → **node**",
  "a `.sln`/`.slnx`/`.csproj`/`.fsproj` at the root or one level under `src/`, `tests/` or `test/` → **dotnet**",
  "`pyproject.toml`, `requirements*.txt`, `setup.py`/`setup.cfg` or `Pipfile` → **python**",
  "`go.mod` → **go**",
];
