import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadDotenv({ path: resolve(process.cwd(), ".env") });
loadDotenv({ path: resolve(process.cwd(), "../.env") });

const here = dirname(fileURLToPath(import.meta.url));

export const paths = {
  repoRoot: resolve(here, "..", ".."),
  rolesDir: resolve(here, "..", "..", "roles"),
  templatesDir: resolve(here, "..", "..", "templates"),
  runsDir: resolve(here, "..", "..", "runs"),
  sessionsDir: resolve(here, "..", "..", "sessions"),
  frontendDist: resolve(here, "..", "..", "frontend", "dist"),
} as const;

export const config = {
  port: Number(process.env.PORT ?? 5174),
  host: process.env.HOST ?? "127.0.0.1",
  logLevel: process.env.LOG_LEVEL ?? "info",
  // Optional. The SDK will reuse the local Claude CLI login (claude /login) when
  // this is unset, so most users won't need it.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6",
  aiGuidelinePathDefault: process.env.AI_GUIDELINE_PATH_DEFAULT ?? "docs/ai-guideline",
  retry: {
    maxAttempts: Number(process.env.RUN_RETRY_MAX_ATTEMPTS ?? 3),
    initialDelayMs: Number(process.env.RUN_RETRY_INITIAL_DELAY_MS ?? 1000),
  },
  branchNameTemplate: process.env.BRANCH_NAME_TEMPLATE ?? "feature/{ticket}-{slug}",
} as const;
