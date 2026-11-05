import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config, paths } from "../config.js";
import { emit, readEventLog } from "../events.js";
import { auditLog, recordActivity } from "../orchestrator/activity.js";
import { refreshOverlaps } from "../orchestrator/overlaps.js";
import { log } from "../log.js";
import { listArtifactsForRun } from "../orchestrator/artifacts.js";
import { testJiraMcp } from "../external/jiraMcp.js";
import { describeJiraMcp } from "../external/jiraMcpConfig.js";
import { detectStacks, STACK_IDS, STACKS } from "../stacks.js";
import { RepoSourceError, resolveRepoSource } from "../orchestrator/repoSources.js";
import { createRun, listArchivedRuns, listRuns, loadRun, totalCostUsd, usageTotals } from "../orchestrator/runStore.js";
import { ATTEMPT_COLUMNS, attemptRows, computeAnalytics, runRows, toCsv } from "../orchestrator/analytics.js";
import { ROLES, type RoleId } from "../orchestrator/types.js";
import {
  abortRun,
  jumpToRole,
  removeRun,
  removeRunWorkspaces,
  resumeAfterApproval,
  roleSlots,
  skipCurrent,
  startRun,
} from "../orchestrator/workflow.js";

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

const RemoveWorkspacesBody = z.object({
  /** Discard uncommitted changes in the worktrees. */
  force: z.boolean().default(false),
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
  /** Liveness for container health checks (no data, no auth). */
  app.get("/healthz", async () => ({ ok: true }));

  /** Server-side defaults the UI shows (model per role, limits). */
  app.get("/api/config", async () => ({
    roles: ROLES,
    models: config.models,
    maxFixIterations: config.maxFixIterations,
    maxRunCostUsd: config.maxRunCostUsd,
    reviewAutoRoute: config.reviewAutoRoute,
    jira: describeJiraMcp(),
    repoSources: { allowLocalPaths: config.repoSources.allowLocalPaths, allowedUrlPrefixes: config.repoSources.allowedUrlPrefixes },
    stacks: STACK_IDS.map((id) => ({ id, label: STACKS[id].label, summary: STACKS[id].guidance.summary })),
    maxConcurrentRoles: config.maxConcurrentRoles,
    ports: config.ports,
    syncBaseBeforePr: config.syncBaseBeforePr,
    worktreesDir: paths.worktreesDir,
  }));

  /** Detected stacks for a repo path (the launch dialog shows them before launching). */
  app.get<{ Querystring: { path?: string } }>("/api/stacks/detect", async (req, reply) => {
    const path = req.query.path ?? "";
    if (!config.repoSources.allowLocalPaths) {
      reply.code(400).send({ error: "local_paths_disabled" });
      return;
    }
    if (!path || !existsSync(path)) {
      reply.code(400).send({ error: "repo_not_found" });
      return;
    }
    return { stacks: detectStacks(path) };
  });

  /** Global role-session slots (shared by all runs). */
  app.get("/api/slots", async () => ({
    limit: config.maxConcurrentRoles,
    running: roleSlots.running,
    queued: roleSlots.queued,
  }));

  /** Connects to the configured JIRA MCP server and reports status and tools. */
  app.post("/api/jira/test", async () => testJiraMcp());

  app.post("/api/runs", async (req, reply) => {
    const parsed = LaunchBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: "invalid_body", detail: parsed.error.flatten() });
      return;
    }
    // Each entry is a local checkout path or a Git URL (cloned/fetched into REPOS_DIR).
    const resolved: Array<{ path: string; url: string | null }> = [];
    for (const r of parsed.data.repos) {
      try {
        resolved.push(await resolveRepoSource(r.path));
      } catch (err) {
        reply.code(400).send({ error: err instanceof RepoSourceError ? "repo_rejected" : "repo_unavailable", repoPath: r.path, detail: errMsg(err) });
        return;
      }
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

    const runId = `${label}-${nanoid(6)}`;
    const repos = parsed.data.repos.map((r, i) => ({
      path: resolved[i]!.path,
      ...(resolved[i]!.url ? { url: resolved[i]!.url } : {}),
      baseBranch: r.baseBranch ?? "master",
      aiGuidelinePath: resolveAiGuidelinePath(resolved[i]!.path, r.aiGuidelinePath),
      stacks: r.stacks && r.stacks.length > 0 ? r.stacks : detectStacks(resolved[i]!.path),
    }));
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
      createdBy: { sub: req.user!.sub, name: req.user!.name },
    });
    await recordActivity(runId, req.user!, "launch", { source: source.kind, repos: repos.map((r) => r.path) }, req.ip);

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
      createdBy: r.createdBy,
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
    const gate = loadRun(req.params.id)?.pendingApproval;
    try {
      if (gate) {
        await recordActivity(
          req.params.id,
          req.user!,
          parsed.data.decision === "approve" ? "approve" : parsed.data.decision,
          { gate: gate.action, role: gate.role, ...(parsed.data.feedback ? { feedback: parsed.data.feedback.slice(0, 500) } : {}), ...(parsed.data.editedPayload ? { edited: true } : {}) },
          req.ip,
        );
      }
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
      const from = loadRun(req.params.id)?.state;
      await skipCurrent(req.params.id);
      await recordActivity(req.params.id, req.user!, "skip", { from }, req.ip);
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
      await recordActivity(req.params.id, req.user!, "jump", { to: parsed.data.to }, req.ip);
      reply.send({ ok: true });
    } catch (err) {
      reply.code(400).send({ error: "jump_failed", detail: errMsg(err) });
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
      await recordActivity(req.params.id, req.user!, "remove_worktrees", { force: parsed.data.force, removed: results.filter((r) => r.removed).length }, req.ip);
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
      await recordActivity(req.params.id, req.user!, "archive", { force: parsed.data.force }, req.ip);
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
      // The run folder is gone; this lands in the audit log only.
      await recordActivity(req.params.id, req.user!, "delete", { force: req.query.force === "true" }, req.ip);
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
    await recordActivity(req.params.id, req.user!, "abort", {}, req.ip);
    reply.send({ ok: true });
  });

  /** Audit log (admins): who did what, including logins, denials and actions on deleted runs. */
  app.get<{ Querystring: { limit?: string; before?: string; runId?: string; user?: string; action?: string } }>("/api/audit", async (req) => {
    const audit = auditLog();
    if (!audit.enabled) return { enabled: false, entries: [] };
    const q = req.query;
    return {
      enabled: true,
      entries: await audit.list({
        limit: q.limit ? Number(q.limit) : undefined,
        before: q.before ? Number(q.before) : undefined,
        runId: q.runId || undefined,
        userSub: q.user || undefined,
        action: q.action || undefined,
      }),
    };
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
