# Stack guide

<!-- Generated from backend/src/stacks.ts by `npm run sync:prompts`; do not edit by hand. -->

The orchestrator detects each repo's stack and passes it to every subagent, which reads its section below.

## Detecting the stack

- `package.json` depending on `vue`/`nuxt` → **vue**; on `react`/`next` → **react**; on `typescript` or with a `tsconfig.json` → **typescript**; otherwise → **node**
- a `.sln`/`.slnx`/`.csproj`/`.fsproj` at the root or one level under `src/`, `tests/` or `test/` → **dotnet**
- `pyproject.toml`, `requirements*.txt`, `setup.py`/`setup.cfg` or `Pipfile` → **python**
- `go.mod` → **go**

A repo can have several stacks (e.g. `react` + `go`). Use every matching section.

## TypeScript (Node) (`typescript`)

Vitest or Jest (whichever the repo uses) for unit tests, `tsc --noEmit`/`npm run typecheck` for types, Playwright for E2E.

- **Unit tests:** Use the repo's runner (Vitest or Jest), co-located `*.test.ts`/`*.spec.ts` or the existing `test/` layout. Type the test code too; `tsc` must stay clean.
- **Integration tests:** Exercise real modules together: e.g. an HTTP app via `supertest` (Express/Fastify `inject`), real service + repository with an in-memory or test database if the repo has one.
- **E2E:** Playwright (`@playwright/test`): tests under the existing e2e folder, one flow per user-facing AC, stable `data-testid`/role selectors, `webServer` in `playwright.config.*` to start the app. An existing suite looks like a `playwright.config.ts|js|mjs` file (or a `test:e2e`/`e2e` script).
- **Review checks:** Run the lint and typecheck scripts; `npm audit` for dependencies. Watch for `any` leaks, unhandled promises, missing input validation at API boundaries.
- **Ports:** Most Node dev servers read `PORT`; Vite needs `--port $PORT` (or `server.port` from env). Point Playwright's `webServer.port`/`use.baseURL` at `E2E_PORT`/`E2E_BASE_URL`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `npm test`, `npx vitest run <file>`, `npx tsc --noEmit` |
| Lint | `npm run lint`, `npm run typecheck` |
| Build | `npm run build` |
| Dependency audit | `npm audit` |
| E2E | `npx playwright test` |
| Install (E2E setup, after approval) | `npm install -D @playwright/test`, `npx playwright install` |

## Node.js (JavaScript) (`node`)

The repo's runner (Vitest, Jest, Mocha or `node --test`) for unit tests, Playwright for E2E.

- **Unit tests:** Use the existing runner and layout (`*.test.js`, `test/`). If there is none but Node ≥ 18, `node:test` with `node --test` needs no dependencies.
- **Integration tests:** Exercise real modules together, e.g. HTTP endpoints via `supertest`, real service + data layer with a test database if available.
- **E2E:** Playwright (`@playwright/test`): tests under the existing e2e folder, one flow per user-facing AC, stable `data-testid`/role selectors, `webServer` in `playwright.config.*` to start the app. An existing suite looks like a `playwright.config.ts|js|mjs` file (or a `test:e2e`/`e2e` script).
- **Review checks:** Run the lint script; `npm audit` for dependencies. Watch for unvalidated input, unhandled promise rejections, prototype pollution.
- **Ports:** Most Node dev servers read `PORT`; Vite needs `--port $PORT` (or `server.port` from env). Point Playwright's `webServer.port`/`use.baseURL` at `E2E_PORT`/`E2E_BASE_URL`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `npm test`, `npx vitest run <file>`, `node --test` |
| Lint | `npm run lint`, `npm run typecheck` |
| Build | `npm run build` |
| Dependency audit | `npm audit` |
| E2E | `npx playwright test` |
| Install (E2E setup, after approval) | `npm install -D @playwright/test`, `npx playwright install` |

## Vue (`vue`)

Vitest + `@vue/test-utils` for component/unit tests, `vue-tsc --noEmit` for types, Playwright for E2E.

- **Unit tests:** Vitest + `@vue/test-utils`: `mount`/`shallowMount`, find by `data-testid` or role, assert rendered output and emitted events, not internals. For Pinia stores use `createTestingPinia` or a fresh `setActivePinia(createPinia())`.
- **Integration tests:** Mount pages/feature components with the real router and store, stubbing only the network (MSW or the repo's API mock). If the repo has a backend in the same run, test the API there.
- **E2E:** Playwright (`@playwright/test`): tests under the existing e2e folder, one flow per user-facing AC, stable `data-testid`/role selectors, `webServer` in `playwright.config.*` to start the app. An existing suite looks like a `playwright.config.ts|js|mjs` file (or a `test:e2e`/`e2e` script).
- **Review checks:** Run `vue-tsc`/typecheck and lint. Watch for `v-html` with untrusted data (XSS), reactivity loss from destructuring, missing `key` on `v-for`, watchers without cleanup.
- **Ports:** Start Vite with `--port $PORT --strictPort`. Point Playwright's `webServer`/`baseURL` at `E2E_PORT`/`E2E_BASE_URL`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `npm test`, `npx vitest run <file>`, `npx vue-tsc --noEmit` |
| Lint | `npm run lint`, `npm run typecheck` |
| Build | `npm run build` |
| Dependency audit | `npm audit` |
| E2E | `npx playwright test` |
| Install (E2E setup, after approval) | `npm install -D @playwright/test`, `npx playwright install` |

## React (`react`)

Vitest or Jest + React Testing Library for unit/component tests, Playwright for E2E.

- **Unit tests:** React Testing Library: render, query by role/label/text (`getByRole`), drive with `userEvent`, assert what the user sees. Don't test hooks' internals or component state directly; test hooks with `renderHook` only when they are the unit.
- **Integration tests:** Render routes/feature trees with real providers (router, store, query client), mocking only the network (MSW or the repo's mocks). If the repo has a backend in the same run, test the API there.
- **E2E:** Playwright (`@playwright/test`): tests under the existing e2e folder, one flow per user-facing AC, stable `data-testid`/role selectors, `webServer` in `playwright.config.*` to start the app. An existing suite looks like a `playwright.config.ts|js|mjs` file (or a `test:e2e`/`e2e` script).
- **Review checks:** Run lint (incl. `react-hooks` rules) and typecheck. Watch for `dangerouslySetInnerHTML` with untrusted data, stale closures in effects, missing effect cleanup, unstable `key`s.
- **Ports:** Vite: `--port $PORT --strictPort`; CRA/Next read `PORT`. Point Playwright's `webServer`/`baseURL` at `E2E_PORT`/`E2E_BASE_URL`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `npm test`, `npx vitest run <file>` |
| Lint | `npm run lint`, `npm run typecheck` |
| Build | `npm run build` |
| Dependency audit | `npm audit` |
| E2E | `npx playwright test` |
| Install (E2E setup, after approval) | `npm install -D @playwright/test`, `npx playwright install` |

## C# / .NET (`dotnet`)

xUnit, NUnit or MSTest (whichever test projects use) via `dotnet test`, `WebApplicationFactory` for integration, Microsoft.Playwright for E2E.

- **Unit tests:** Add tests to the existing `*.Tests` project for the code under test (same framework and assertion library: xUnit `[Fact]/[Theory]`, NUnit `[Test]`, MSTest `[TestMethod]`). Run a subset with `dotnet test --filter`. Only create a new test project if none exists, mirroring the solution's conventions.
- **Integration tests:** For ASP.NET Core use `WebApplicationFactory<Program>` (Microsoft.AspNetCore.Mvc.Testing) and call real endpoints with its `HttpClient`; use Testcontainers or the repo's test database setup only if it already exists, otherwise mark DB-dependent tests env-missing.
- **E2E:** Microsoft.Playwright with the repo's test framework (e.g. `Microsoft.Playwright.NUnit`/`.MSTest`/xUnit fixture) in a dedicated E2E test project, run via `dotnet test`. Browsers install with `pwsh bin/<Configuration>/<tfm>/playwright.ps1 install`. An existing suite looks like a test project referencing `Microsoft.Playwright` (check the `*.csproj` files).
- **Review checks:** Run `dotnet build` (treat new warnings as findings), `dotnet format --verify-no-changes` if the repo uses it, `dotnet list package --vulnerable`. Watch for missing `await`/`async void`, `IDisposable` leaks, SQL built by string concatenation, missing `[Authorize]`, nullable warnings.
- **Ports:** Run the app with `ASPNETCORE_URLS` (already set to the run's base port) or `dotnet run --urls $E2E_BASE_URL`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `dotnet test`, `dotnet test --filter "FullyQualifiedName~Orders"` |
| Lint | `dotnet build`, `dotnet format --verify-no-changes` |
| Build | `dotnet build` |
| Dependency audit | `dotnet list package --vulnerable` |
| E2E | `dotnet test <E2E test project>` |
| Install (E2E setup, after approval) | `dotnet add <project> package Microsoft.Playwright.NUnit`, `pwsh bin/Debug/<tfm>/playwright.ps1 install` |

## Python (`python`)

pytest (or the repo's `unittest` suite), run inside the run's virtualenv; pytest-playwright for E2E.

- **Unit tests:** pytest: `tests/` (or the existing layout), `test_*.py`, plain `assert`, fixtures in `conftest.py`, `pytest.mark.parametrize` for cases. Keep the repo's style if it uses `unittest`. The run's `.venv` is on PATH, so `pytest` / `python -m pytest` use the project's dependencies.
- **Integration tests:** Use the framework's test client against the real app: FastAPI `TestClient`/`httpx.AsyncClient`, Flask `app.test_client()`, Django `TestCase` + `Client`. Use the repo's test database setup if it exists (e.g. SQLite or Django's test DB); otherwise mark external-service tests env-missing.
- **E2E:** pytest-playwright (`page` fixture) in an `e2e`/`tests/e2e` folder, run with `pytest`. Browsers install with `python -m playwright install`. An existing suite looks like tests using the `page` fixture from `pytest-playwright` (check dev dependencies and `tests/e2e`).
- **Review checks:** Run the configured linters (ruff, mypy/pyright, flake8/black) and `pip-audit` if available. Watch for SQL/command injection (f-strings into queries or `subprocess` with `shell=True`), unsafe `pickle`/`yaml.load`, mutable default arguments, broad `except:`.
- **Ports:** Start servers on `$PORT`: `uvicorn app:app --port $PORT`, `flask run --port $PORT`, `python manage.py runserver $PORT`.

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `pytest -q`, `python -m pytest tests/unit -k <name>` |
| Lint | `ruff check .`, `mypy <package>` |
| Build | `python -m compileall -q <package>` |
| Dependency audit | `pip-audit` |
| E2E | `pytest tests/e2e` |
| Install (E2E setup, after approval) | `pip install pytest-playwright`, `python -m playwright install` |

## Go (`go`)

`go test ./...` with table-driven tests, `httptest` for integration, `go vet`/golangci-lint for checks.

- **Unit tests:** `_test.go` files next to the code (same package, or `_test` package for black-box tests), table-driven `t.Run` subtests, the standard `testing` package plus whatever assertion library the repo already uses. Run one test with `go test ./pkg/... -run TestName`.
- **Integration tests:** Use `httptest.NewServer`/`httptest.NewRecorder` against the real handlers and services; guard tests that need external services with a build tag or `testing.Short()` and mark them env-missing.
- **E2E:** If the repo (or another repo in this run) has a Playwright setup, use it against the Go server. Otherwise write Go tests behind an `e2e` build tag that start the server on `$PORT` and drive it over HTTP (`go test -tags e2e ./...`). An existing suite looks like a Playwright config in the repo or a sibling frontend, or tests behind an `e2e` build tag.
- **Review checks:** Run `go vet`, `gofmt -l`, `golangci-lint run` if configured, `govulncheck` if installed. Watch for unchecked errors, goroutine leaks, data races (suggest `go test -race`), missing `defer Close()`, context not propagated.
- **Ports:** Have the server read `PORT` (or pass a `-addr :$PORT` flag).

| Purpose | Commands |
| ------- | -------- |
| Test / typecheck | `go test ./...`, `go test ./<pkg> -run <TestName>` |
| Lint | `go vet ./...`, `gofmt -l .`, `golangci-lint run` |
| Build | `go build ./...` |
| Dependency audit | `govulncheck ./...` |
| E2E | `go test -tags e2e ./...` |
| Install (E2E setup, after approval) | `go get <module>` |
