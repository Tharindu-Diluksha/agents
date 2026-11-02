import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "../config.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { listArtifactsForRun } from "../orchestrator/artifacts.js";
import { createRun, listRuns, loadRun, totalCostUsd } from "../orchestrator/runStore.js";
import { ROLES, type RoleId } from "../orchestrator/types.js";
import { abortRun, jumpToRole, resumeAfterApproval, skipCurrent, startRun } from "../orchestrator/workflow.js";

const RepoBody = z.object({
  path: z.string().min(1),
  baseBranch: z.string().optional(),
  aiGuidelinePath: z.string().optional(),
});

const JiraSourceBody = z.object({
  kind: z.literal("jira"),
  ticketUrl: z.string().url(),
});

const ManualSourceBody = z.object({
  kind: z.literal("manual"),
  type: z.enum(["feature", "change", "fix"]),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.array(z.string()).default([]),
});

const ModelsBody = z
  .object(Object.fromEntries(ROLES.map((r) => [r, z.string().trim().optional()])) as Record<RoleId, z.ZodOptional<z.ZodString>>)
  .partial()
  .optional();

const LaunchBody = z.object({
  source: z.discriminatedUnion("kind", [JiraSourceBody, ManualSourceBody]),
  repos: z.array(RepoBody).min(1),
  /** Per-role model overrides for this run; blank/missing roles use the server defaults. */
  models: ModelsBody,
});

const ApproveBody = z.object({
  decision: z.enum(["approve", "reject", "edit", "skip"]),
  editedPayload: z.string().optional(),
  feedback: z.string().optional(),
});

const JumpBody = z.object({
  to: z.enum(ROLES),
});

function deriveTicketKey(url: string): string {
  const m = url.match(/[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : nanoid(8);
}

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "manual";
}

export async function registerRunsRoutes(app: FastifyInstance): Promise<void> {
  /** Server-side defaults the UI shows (model per role, limits). */
  app.get("/api/config", async () => ({
    roles: ROLES,
    models: config.models,
    maxFixIterations: config.maxFixIterations,
    maxRunCostUsd: config.maxRunCostUsd,
    reviewAutoRoute: config.reviewAutoRoute,
  }));

  app.post("/api/runs", async (req, reply) => {
    const parsed = LaunchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    const missing = parsed.data.repos.find((r) => !existsSync(r.path));
    if (missing) {
      reply.code(400).send({ error: "repo_not_found", repoPath: missing.path });
      return;
    }

    let label: string;
    let source;
    if (parsed.data.source.kind === "jira") {
      const ticket = deriveTicketKey(parsed.data.source.ticketUrl);
      label = ticket;
      source = { kind: "jira" as const, ticket, ticketUrl: parsed.data.source.ticketUrl };
    } else {
      label = slugifyTitle(parsed.data.source.title);
      source = {
        kind: "manual" as const,
        type: parsed.data.source.type,
        title: parsed.data.source.title,
        description: parsed.data.source.description,
        acceptanceCriteria: parsed.data.source.acceptanceCriteria,
      };
    }

    const runId = `${label}-${nanoid(6)}`;
    const repos = parsed.data.repos.map((r) => ({
      path: r.path,
      baseBranch: r.baseBranch ?? "master",
      aiGuidelinePath: resolveAiGuidelinePath(r.path, r.aiGuidelinePath),
    }));
    const models = Object.fromEntries(
      Object.entries(parsed.data.models ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0),
    ) as Partial<Record<RoleId, string>>;
    const record = createRun({
      runId,
      label,
      source,
      repos,
      models: Object.keys(models).length > 0 ? models : undefined,
    });

    emit({ type: "run.created", runId, label, repoPaths: repos.map((r) => r.path) });
    try {
      await startRun(runId);
    } catch (err) {
      log.error("routes.startRun_failed", { runId, err: err instanceof Error ? err.message : String(err) });
    }
    reply.code(201).send({ runId: record.runId, state: record.state });
  });

  app.get("/api/runs", async () => {
    const runs = listRuns().map((r) => ({
      runId: r.runId,
      label: r.label,
      source: r.source,
      repos: r.repos,
      state: r.state,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      pendingApproval: r.pendingApproval,
      totalCostUsd: totalCostUsd(r),
    }));
    return { runs };
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const record = loadRun(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    return {
      ...record,
      totalCostUsd: totalCostUsd(record),
      effectiveModels: Object.fromEntries(ROLES.map((r) => [r, record.models?.[r] || config.models[r]])),
      artifacts: listArtifactsForRun(record).map((a) => ({ owner: a.owner, name: a.name, relative: a.relative })),
    };
  });

  app.get<{ Params: { id: string; "*": string } }>("/api/runs/:id/artifacts/*", async (req, reply) => {
    const record = loadRun(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const sub = (req.params as Record<string, string>)["*"] ?? "";
    const list = listArtifactsForRun(record);
    const match = list.find((a) => a.relative.endsWith(sub) || a.file.endsWith(sub));
    if (!match) {
      reply.code(404).send({ error: "artifact_not_found" });
      return;
    }
    const body = readFileSync(match.file, "utf8");
    reply.header("content-type", "text/markdown; charset=utf-8").send(body);
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/approve", async (req, reply) => {
    const parsed = ApproveBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    try {
      await resumeAfterApproval(
        req.params.id,
        parsed.data.decision,
        parsed.data.editedPayload,
        parsed.data.feedback,
      );
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "approval_failed", detail: errMsg(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/skip", async (req, reply) => {
    try {
      await skipCurrent(req.params.id);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "skip_failed", detail: errMsg(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/jump", async (req, reply) => {
    const parsed = JumpBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    try {
      await jumpToRole(req.params.id, parsed.data.to as RoleId);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "jump_failed", detail: errMsg(err) });
    }
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/abort", async (req, reply) => {
    abortRun(req.params.id);
    reply.send({ ok: true });
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decides the aiGuidelinePath to record for a run.
 * Priority:
 *   1. An explicit, non-empty aiGuidelinePath supplied in the launch body (even
 *      if the folder doesn't exist — the run records the intent).
 *   2. AI_GUIDELINE_PATH_DEFAULT env var, but only if that folder actually
 *      exists in the target repo. Falls back to null otherwise, so unrelated
 *      repos don't get phantom AI guideline instructions.
 */
function resolveAiGuidelinePath(repoPath: string, requested: string | undefined): string | null {
  if (requested !== undefined) {
    const trimmed = requested.trim();
    return trimmed === "" ? null : trimmed;
  }
  const def = config.aiGuidelinePathDefault.trim();
  if (!def) return null;
  return existsSync(join(repoPath, def)) ? def : null;
}
