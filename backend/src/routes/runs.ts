import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config, paths } from "../config.js";
import { emit, readEventLog } from "../events.js";
import { refreshOverlaps } from "../orchestrator/overlaps.js";
import { log } from "../log.js";
import { listArtifactsForRun } from "../orchestrator/artifacts.js";
import { testJiraMcp } from "../external/jiraMcp.js";
import { describeJiraMcp } from "../external/jiraMcpConfig.js";
import { detectProjects, projectsFor, STACK_IDS, STACKS } from "../stacks.js";
import { createRun, listArchivedRuns, listRuns, loadRun, saveRun, totalCostUsd, usageTotals } from "../orchestrator/runStore.js";
import {
  addAttachments,
  attachmentFile,
  checkContext,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REQUEST,
} from "../orchestrator/attachments.js";
import { ATTEMPT_COLUMNS, attemptRows, computeAnalytics, runRows, toCsv } from "../orchestrator/analytics.js";
import { EFFORT_LEVELS, REQUIRED_ROLES, ROLES, type RoleId } from "../orchestrator/types.js";
import {
  abortRun,
  jumpToRole,
  removeRun,
  removeRunWorkspaces,
  resumeAfterApproval,
  roleSlots,
  setRoleSettings,
  skipCurrent,
  startRun,
} from "../orchestrator/workflow.js";
import { inPlaceProblem } from "../orchestrator/workspaces.js";

const RepoBody = z.object({
  path: z.string().min(1),
  baseBranch: z.string().optional(),
  aiGuidelinePath: z.string().optional(),
  /** Explicit stacks; omitted or empty = auto-detect from the repo's files. */
  stacks: z.array(z.enum(STACK_IDS)).optional(),
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

const ContextBody = z.object({
  note: z.string().optional(),
  images: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        mediaType: z.string(),
        data: z.string().min(1),
        caption: z.string().max(500).optional(),
      }),
    )
    .optional(),
});

/** Up to MAX_IMAGES_PER_REQUEST images of MAX_IMAGE_BYTES, base64 (+33%), plus the rest of the body. */
const CONTEXT_BODY_LIMIT = Math.ceil((MAX_IMAGES_PER_REQUEST * MAX_IMAGE_BYTES * 4) / 3) + 1024 * 1024;

const EffortsBody = z.partialRecord(z.enum(ROLES), z.enum(EFFORT_LEVELS)).optional();

const LaunchBody = z.object({
  source: z.discriminatedUnion("kind", [JiraSourceBody, ManualSourceBody]),
  repos: z.array(RepoBody).min(1),
  /** Per-role model overrides for this run; blank/missing roles use the server defaults. */
  models: ModelsBody,
  /** Per-role reasoning effort for this run; missing roles use the server default (or the model's). */
  efforts: EffortsBody,
  /** Optional roles to turn off for this run. Analyst, Developer and Reviewer can't be turned off. */
  disabledRoles: z
    .array(z.enum(ROLES))
    .optional()
    .refine((roles) => !roles?.some((r) => REQUIRED_ROLES.includes(r)), {
      message: `${REQUIRED_ROLES.join(", ")} are required and can't be turned off`,
    }),
  /** Extra notes and images (e.g. mockups not in JIRA) every role can see. */
  context: ContextBody.optional(),
  /** `worktree` (default): isolated worktree per repo. `in-place`: a new branch in the user's checkout. */
  workspace: z.enum(["worktree", "in-place"]).optional(),
});

const ApproveBody = z.object({
  decision: z.enum(["approve", "reject", "edit", "skip"]),
  editedPayload: z.string().optional(),
  feedback: z.string().optional(),
});

const RemoveWorkspacesBody = z.object({
  /** Discard uncommitted changes in the worktrees. */
  force: z.boolean().default(false),
});

/** null = back to the server default; a missing key leaves that setting as it is. */
const RoleSettingsBody = z.object({
  model: z.string().trim().max(200).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
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
    requiredRoles: REQUIRED_ROLES,
    models: config.models,
    modelOptions: config.modelOptions,
    efforts: config.efforts,
    effortLevels: EFFORT_LEVELS,
    maxFixIterations: config.maxFixIterations,
    maxRunCostUsd: config.maxRunCostUsd,
    reviewAutoRoute: config.reviewAutoRoute,
    jira: describeJiraMcp(),
    stacks: STACK_IDS.map((id) => ({ id, label: STACKS[id].label, summary: STACKS[id].guidance.summary })),
    maxConcurrentRoles: config.maxConcurrentRoles,
    ports: config.ports,
    syncBaseBeforePr: config.syncBaseBeforePr,
    worktreesDir: paths.worktreesDir,
  }));

  /** Detected stacks for a repo path (the launch dialog shows them before launching). */
  app.get<{ Querystring: { path?: string } }>("/api/stacks/detect", async (req, reply) => {
    const path = req.query.path ?? "";
    if (!path || !existsSync(path)) {
      reply.code(400).send({ error: "repo_not_found" });
      return;
    }
    const projects = detectProjects(path);
    return { stacks: [...new Set(projects.map((p) => p.stack))], projects };
  });

  /** Global role-session slots (shared by all runs). */
  app.get("/api/slots", async () => ({
    limit: config.maxConcurrentRoles,
    running: roleSlots.running,
    queued: roleSlots.queued,
  }));

  /** Connects to the configured JIRA MCP server and reports status and tools. */
  app.post("/api/jira/test", async () => testJiraMcp());

  app.post("/api/runs", { bodyLimit: CONTEXT_BODY_LIMIT }, async (req, reply) => {
    const parsed = LaunchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    const context = parsed.data.context;
    const hasContext = Boolean(context?.note?.trim() || context?.images?.length);
    if (hasContext) {
      try {
        checkContext(context!);
      } catch (err) {
        reply.code(400).send({ error: "invalid_context", detail: errMsg(err) });
        return;
      }
    }
    const missing = parsed.data.repos.find((r) => !existsSync(r.path));
    if (missing) {
      reply.code(400).send({ error: "repo_not_found", repoPath: missing.path });
      return;
    }

    if (parsed.data.source.kind === "jira") {
      const jira = describeJiraMcp();
      if (!jira.configured) {
        reply.code(400).send({
          error: "jira_mcp_not_configured",
          detail: jira.error ?? "Configure a JIRA MCP server (jira-mcp.json or JIRA_MCP_* env vars) or use a manual description.",
        });
        return;
      }
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

    const workspace = parsed.data.workspace ?? "worktree";
    if (workspace === "in-place") {
      const problem = await inPlaceProblem(parsed.data.repos.map((r) => ({ path: r.path, baseBranch: r.baseBranch ?? "master" })));
      if (problem) {
        reply.code(400).send({ error: "checkout_not_ready", detail: problem });
        return;
      }
    }

    const runId = `${label}-${nanoid(6)}`;
    const repos = parsed.data.repos.map((r) => {
      const detected = detectProjects(r.path);
      // Chosen stacks override detection, but keep the folders detection found for them.
      const projects = r.stacks && r.stacks.length > 0 ? projectsFor(r.stacks, detected) : detected;
      return {
        path: r.path,
        baseBranch: r.baseBranch ?? "master",
        aiGuidelinePath: resolveAiGuidelinePath(r.path, r.aiGuidelinePath),
        stacks: [...new Set(projects.map((p) => p.stack))],
        projects,
      };
    });
    const unknown = repos.find((r) => r.stacks.length === 0);
    if (unknown) {
      reply.code(400).send({
        error: "stack_not_detected",
        repoPath: unknown.path,
        detail: `Could not tell the tech stack of ${unknown.path}; choose one in the launch dialog (supported: ${STACK_IDS.join(", ")}).`,
      });
      return;
    }
    const models = Object.fromEntries(
      Object.entries(parsed.data.models ?? {}).filter(([, v]) => typeof v === "string" && v.length > 0),
    ) as Partial<Record<RoleId, string>>;
    const record = createRun({
      runId,
      label,
      source,
      repos,
      models: Object.keys(models).length > 0 ? models : undefined,
      efforts: parsed.data.efforts && Object.keys(parsed.data.efforts).length > 0 ? parsed.data.efforts : undefined,
      disabledRoles: [...new Set(parsed.data.disabledRoles ?? [])],
      workspace,
    });

    if (hasContext) {
      addAttachments(record, context!); // already validated above
      saveRun(record);
    }
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
      totalUsage: usageTotals(r),
      overlaps: r.overlaps ?? [],
      pauseReason: r.pauseReason,
      failureReason: r.failureReason,
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
      totalUsage: usageTotals(record),
      effectiveModels: Object.fromEntries(ROLES.map((r) => [r, record.models?.[r] || config.models[r]])),
      /** null = the model's default effort. */
      effectiveEfforts: Object.fromEntries(ROLES.map((r) => [r, record.efforts?.[r] ?? config.efforts[r]])),
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

  /**
   * Adds notes / images to a run's context. Roles see them from their next
   * attempt on (e.g. reject the feature doc to have the Analyst use them).
   */
  app.post<{ Params: { id: string } }>("/api/runs/:id/attachments", { bodyLimit: CONTEXT_BODY_LIMIT }, async (req, reply) => {
    const record = loadRun(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    if (record.state === "done") {
      reply.code(409).send({ error: "run_finished", detail: "the run is done; no role will read new context" });
      return;
    }
    const parsed = ContextBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    try {
      const added = addAttachments(record, parsed.data);
      saveRun(record);
      emit({ type: "run.attachments", runId: record.runId, added: added.length });
      reply.send({ attachments: added });
    } catch (err) {
      reply.code(400).send({ error: "invalid_context", detail: errMsg(err) });
    }
  });

  /** One of the run's images (for thumbnails in the UI). */
  app.get<{ Params: { id: string; file: string } }>("/api/runs/:id/attachments/:file", async (req, reply) => {
    const record = loadRun(req.params.id);
    const found = record ? attachmentFile(record, req.params.file) : null;
    if (!found) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    reply
      .header("content-type", found.mediaType)
      .header("x-content-type-options", "nosniff")
      .header("cache-control", "private, max-age=86400")
      .send(readFileSync(found.path));
  });

  /** Model / effort for a role's next attempt. Refused while that role is running or queued. */
  app.put<{ Params: { id: string; role: string } }>("/api/runs/:id/roles/:role/settings", async (req, reply) => {
    const role = z.enum(ROLES).safeParse(req.params.role);
    const parsed = RoleSettingsBody.safeParse(req.body ?? {});
    if (!role.success || !parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: role.success ? parsed.error?.flatten() : `unknown role ${req.params.role}` });
      return;
    }
    if (!loadRun(req.params.id)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    try {
      reply.send(setRoleSettings(req.params.id, role.data, parsed.data));
    } catch (err) {
      reply.code(409).send({ error: "settings_rejected", detail: errMsg(err) });
    }
  });

  /** Persisted event stream (runs/<id>/events.jsonl), oldest first, for replay on page load. */
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/runs/:id/events", async (req, reply) => {
    if (!loadRun(req.params.id)) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 5000) || 5000, 1), 20000);
    return { events: readEventLog(req.params.id, limit) };
  });

  /** Re-computes file overlaps with other active runs on the same repos. */
  app.post<{ Params: { id: string } }>("/api/runs/:id/overlaps/refresh", async (req, reply) => {
    const record = loadRun(req.params.id);
    if (!record) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    await refreshOverlaps(record);
    return { overlaps: record.overlaps ?? [] };
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/workspaces/remove", async (req, reply) => {
    const parsed = RemoveWorkspacesBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    try {
      const results = await removeRunWorkspaces(req.params.id, parsed.data.force);
      reply.send({ results });
    } catch (err) {
      reply.code(400).send({ error: "remove_failed", detail: errMsg(err) });
    }
  });

  /** Moves a finished/failed/paused run to runs/.archive (artifacts and history kept, worktrees removed). */
  app.post<{ Params: { id: string } }>("/api/runs/:id/archive", async (req, reply) => {
    const parsed = RemoveWorkspacesBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    try {
      await removeRun(req.params.id, "archive", parsed.data.force);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "archive_failed", detail: errMsg(err) });
    }
  });

  /** Deletes a finished/failed/paused run entirely (worktrees, artifacts, history, sessions). Branches stay. */
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>("/api/runs/:id", async (req, reply) => {
    try {
      await removeRun(req.params.id, "delete", req.query.force === "true");
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "delete_failed", detail: errMsg(err) });
    }
  });

  /** One run's attempts with cost and usage, as JSON (with a run summary) or CSV. */
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/runs/:id/export", async (req, reply) => {
    const record = loadRun(req.params.id) ?? listArchivedRuns().find((r) => r.runId === req.params.id);
    if (!record) {
      reply.code(404).send({ error: "not_found" });
      return;
    }
    const attempts = attemptRows([record]);
    if (req.query.format === "csv") {
      reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${record.runId}-usage.csv"`)
        .send(toCsv(attempts, ATTEMPT_COLUMNS));
      return;
    }
    reply
      .header("content-disposition", `attachment; filename="${record.runId}-usage.json"`)
      .send({ run: runRows([record])[0], attempts });
  });

  /** Cross-run analytics (cost, tokens, fix loops, per-role stats, top pause/failure reasons). */
  app.get<{ Querystring: { archived?: string } }>("/api/analytics", async (req) => {
    return computeAnalytics(runsForAnalytics(req.query.archived !== "false"));
  });

  /** Every attempt of every run (archived included by default) as CSV. */
  app.get<{ Querystring: { archived?: string } }>("/api/analytics/export.csv", async (req, reply) => {
    const rows = attemptRows(runsForAnalytics(req.query.archived !== "false"));
    reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="orchestrator-usage.csv"`)
      .send(toCsv(rows, ATTEMPT_COLUMNS));
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/abort", async (req, reply) => {
    abortRun(req.params.id);
    reply.send({ ok: true });
  });
}

function runsForAnalytics(includeArchived: boolean) {
  return [...listRuns(), ...(includeArchived ? listArchivedRuns() : [])];
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
