import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EFFORT_LEVELS, type EffortLevel } from "./orchestrator/types.js";

loadDotenv({ path: resolve(process.cwd(), ".env") });
loadDotenv({ path: resolve(process.cwd(), "../.env") });

const here = dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";

/** `CLAUDE_MODEL_<ROLE>` overrides `CLAUDE_MODEL` for one role. */
function roleModel(envSuffix: string): string {
  return process.env[`CLAUDE_MODEL_${envSuffix}`] || DEFAULT_MODEL;
}

/**
 * `CLAUDE_EFFORT_<ROLE>` overrides `CLAUDE_EFFORT` for one role. Unset or not a
 * known level = null (the model's own default effort).
 */
function roleEffort(envSuffix: string): EffortLevel | null {
  const raw = (process.env[`CLAUDE_EFFORT_${envSuffix}`] || process.env.CLAUDE_EFFORT || "").trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(raw) ? (raw as EffortLevel) : null;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const paths = {
  repoRoot: resolve(here, "..", ".."),
  rolesDir: resolve(here, "..", "..", "roles"),
  templatesDir: resolve(here, "..", "..", "templates"),
  runsDir: resolve(here, "..", "..", "runs"),
  sessionsDir: resolve(here, "..", "..", "sessions"),
  /** Per-run git worktrees: <worktreesDir>/<runId>/<repoSlug>. */
  worktreesDir: process.env.WORKTREES_DIR ? resolve(process.env.WORKTREES_DIR) : resolve(here, "..", "..", "worktrees"),
  frontendDist: resolve(here, "..", "..", "frontend", "dist"),
} as const;

export const config = {
  port: Number(process.env.PORT ?? 5174),
  host: process.env.HOST ?? "127.0.0.1",
  /**
   * Extra hostnames accepted in Host/Origin headers besides localhost,
   * 127.0.0.1 and ::1 (comma-separated). Only needed when you deliberately
   * expose the UI beyond this machine, e.g. HOST=0.0.0.0 with your LAN name.
   */
  allowedHosts: (process.env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean),
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Optional. The SDK will reuse the local Claude CLI login (claude /login) when
  // this is unset, so most users won't need it.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Default model for every role. Per-role env vars and per-run overrides take precedence. */
  model: DEFAULT_MODEL,
  models: {
    analyst: roleModel("ANALYST"),
    developer: roleModel("DEVELOPER"),
    unitTester: roleModel("UNIT_TESTER"),
    integrationTester: roleModel("INTEGRATION_TESTER"),
    reviewer: roleModel("REVIEWER"),
    e2eTester: roleModel("E2E_TESTER"),
    prCreator: roleModel("PR_CREATOR"),
  },
  /** Reasoning effort per role (`CLAUDE_EFFORT`, `CLAUDE_EFFORT_<ROLE>`); null = the model's default. Per-run overrides take precedence. */
  efforts: {
    analyst: roleEffort("ANALYST"),
    developer: roleEffort("DEVELOPER"),
    unitTester: roleEffort("UNIT_TESTER"),
    integrationTester: roleEffort("INTEGRATION_TESTER"),
    reviewer: roleEffort("REVIEWER"),
    e2eTester: roleEffort("E2E_TESTER"),
    prCreator: roleEffort("PR_CREATOR"),
  },
  /**
   * Models offered in the launch dialog's per-role dropdowns (`CLAUDE_MODEL_OPTIONS`,
   * comma-separated). The configured defaults are always included; any other id
   * can still be typed via "Custom…".
   */
  modelOptions: [
    ...new Set([
      ...(process.env.CLAUDE_MODEL_OPTIONS ?? "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-5-5,claude-fable-5-2")
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      DEFAULT_MODEL,
      ...["ANALYST", "DEVELOPER", "UNIT_TESTER", "INTEGRATION_TESTER", "REVIEWER", "E2E_TESTER", "PR_CREATOR"].map(roleModel),
    ]),
  ],
  /** Fix loops (review rejection, tester → Developer hand-back) allowed before the run pauses. 0 = unlimited. */
  maxFixIterations: num("MAX_FIX_ITERATIONS", 5),
  /** Total USD a run may spend before it pauses. 0 = unlimited. */
  maxRunCostUsd: num("MAX_RUN_COST_USD", 0),
  /**
   * When true, the Reviewer gate is decided automatically from review-findings.json:
   * any BLOCKER/HIGH goes straight back to the Developer, otherwise the run advances.
   */
  reviewAutoRoute: (process.env.REVIEW_AUTO_ROUTE ?? "false").toLowerCase() === "true",
  aiGuidelinePathDefault: process.env.AI_GUIDELINE_PATH_DEFAULT ?? "docs/ai-guideline",
  retry: {
    maxAttempts: num("RUN_RETRY_MAX_ATTEMPTS", 3),
    initialDelayMs: num("RUN_RETRY_INITIAL_DELAY_MS", 1000),
  },
  /** Role sessions allowed to run at once across all runs. 0 = unlimited. */
  maxConcurrentRoles: num("MAX_CONCURRENT_ROLES", 2),
  worktree: {
    /** `git fetch origin <base>` before creating a worktree, so it starts from the latest base. */
    fetchBase: (process.env.WORKTREE_FETCH_BASE ?? "true").toLowerCase() !== "false",
    /** Install dependencies (npm ci / pnpm / yarn, by lockfile) in each new worktree. */
    installDeps: (process.env.WORKTREE_INSTALL_DEPS ?? "true").toLowerCase() !== "false",
    /** Untracked files to copy from the original checkout into each worktree (e.g. `.env.test`). */
    copyFiles: (process.env.WORKTREE_COPY_FILES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
  /**
   * Each run with a worktree reserves a block of PORT_BLOCK_SIZE ports from
   * [PORT_RANGE_START, PORT_RANGE_END) for its dev/test servers, so parallel
   * E2E/integration runs don't collide.
   */
  ports: {
    rangeStart: num("PORT_RANGE_START", 41000),
    rangeEnd: num("PORT_RANGE_END", 42000),
    blockSize: Math.max(1, num("PORT_BLOCK_SIZE", 10)),
  },
  /** Bring the branch up to date with its base (rebase, or merge once pushed) before the PR Creator runs. */
  syncBaseBeforePr: (process.env.SYNC_BASE_BEFORE_PR ?? "true").toLowerCase() !== "false",
  branchNameTemplate: process.env.BRANCH_NAME_TEMPLATE ?? "feature/{ticket}-{slug}",
} as const;
