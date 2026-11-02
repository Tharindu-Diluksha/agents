import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { getSessionId, saveSessionId } from "../orchestrator/sessionStore.js";
import { ROLES, type AttemptUsage, type RoleId, type RoleOutput } from "../orchestrator/types.js";
import type { RoleSpec } from "../roles/types.js";
import { evaluateToolUse, GATED_TOOLS, type GuardContext, type GuardDecision } from "./permissions.js";

// Zod schema accepts both the preferred payloadPaths (string[]) and the legacy
// scalar payloadPath that older role prompts may still emit. We normalize to
// payloadPaths before handing the value out.
export const RoleOutputRawSchema = z.object({
  status: z.enum(["done", "awaiting_approval", "blocked"]),
  artifacts: z.array(z.string()).default([]),
  approvalRequest: z
    .object({
      action: z.enum(["post_jira_comment", "create_test_suite", "create_pr", "proceed_to_next"]),
      summary: z.string(),
      payloadPaths: z.array(z.string()).optional(),
      payloadPath: z.string().nullable().optional(),
    })
    .nullable(),
  handoff: z
    .object({
      // "tester" is accepted for older prompts and normalized to "e2eTester".
      nextRole: z.enum([...ROLES, "tester"]),
      notes: z.string().optional(),
    })
    .nullable(),
});

export function normalizeRoleOutput(raw: z.infer<typeof RoleOutputRawSchema>): RoleOutput {
  const ar = raw.approvalRequest;
  return {
    status: raw.status,
    artifacts: raw.artifacts ?? [],
    approvalRequest: ar
      ? {
          action: ar.action,
          summary: ar.summary,
          payloadPaths:
            ar.payloadPaths && ar.payloadPaths.length > 0
              ? ar.payloadPaths
              : ar.payloadPath
              ? [ar.payloadPath]
              : [],
        }
      : null,
    handoff: raw.handoff
      ? {
          nextRole: raw.handoff.nextRole === "tester" ? "e2eTester" : raw.handoff.nextRole,
          notes: raw.handoff.notes,
        }
      : null,
  };
}

export interface RunRoleAgentArgs {
  runId: string;
  role: RoleId;
  spec: RoleSpec;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  model: string;
  /** Absolute paths of all repos in the run. Bash commands can be prefixed with `cd <any-of-these> && ` and still pass the allowlist. */
  repoPaths: string[];
  /** Absolute directories file-writing tools may write into. */
  writeRoots: string[];
  /** Effective Bash allowlist (static role list plus any state-dependent extras). */
  bashAllowList: RegExp[];
  /** Hard USD cap for this one SDK query (remaining run budget). Omit for no cap. */
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface RunRoleAgentResult {
  sessionId?: string;
  output?: RoleOutput;
  parseError?: string;
  metrics?: RunMetrics;
}

export interface RunMetrics {
  costUsd: number;
  numTurns: number;
  usage: AttemptUsage;
  /** SDK result subtype, e.g. `success`, `error_max_turns`, `error_max_budget_usd`. */
  resultSubtype?: string;
}

/**
 * Runs a role in a Claude Agent SDK session, streaming to the event bus,
 * persisting the SDK session id, and parsing the terminal JSON block.
 *
 * On re-run (sessionStore returns an existing id for runId+role), the SDK is
 * invoked with `resume: <sessionId>` so the role sees its prior attempt.
 *
 * Tool permissions: only the role's tools are made available (`tools`), only
 * read-only tools are auto-approved (`allowedTools`), and every gated tool
 * (Bash, Write, Edit, …) goes through `evaluateToolUse` twice — in a
 * `PreToolUse` hook, which runs before any allow rule, and in `canUseTool`.
 */
export async function runRoleAgent(args: RunRoleAgentArgs): Promise<RunRoleAgentResult> {
  const { runId, role, spec, systemPrompt, userPrompt, cwd, repoPaths, writeRoots, signal } = args;
  const existingSessionId = getSessionId(runId, role);

  const guardCtx: GuardContext = {
    allowedTools: spec.allowedTools,
    bashAllowList: args.bashAllowList,
    repoPaths,
    writeRoots,
    cwd,
  };
  const guard = (toolName: string, input: Record<string, unknown>): GuardDecision => {
    const decision = evaluateToolUse(toolName, input, guardCtx);
    if (!decision.allow) reportDenied(runId, role, toolName, input, decision.reason);
    return decision;
  };

  const builtinTools = spec.allowedTools.filter((t) => !t.startsWith("mcp__"));
  const autoApproved = spec.allowedTools.filter((t) => !GATED_TOOLS.has(t));

  const options: Record<string, unknown> = {
    cwd,
    model: args.model,
    systemPrompt,
    tools: builtinTools,
    allowedTools: autoApproved,
    permissionMode: "default",
    canUseTool: async (toolName: string, input: Record<string, unknown>) => {
      const d = guard(toolName, input);
      return d.allow
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: d.reason };
    },
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (hookInput: { tool_name?: string; tool_input?: unknown }) => {
              const name = String(hookInput.tool_name ?? "");
              const input = (hookInput.tool_input ?? {}) as Record<string, unknown>;
              const d = guard(name, input);
              if (d.allow) return { continue: true };
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: d.reason,
                },
              };
            },
          ],
        },
      ],
    },
    maxTurns: spec.maxTurns ?? 40,
    settingSources: [],
  };
  if (args.maxBudgetUsd !== undefined) options.maxBudgetUsd = args.maxBudgetUsd;
  if (existingSessionId) options.resume = existingSessionId;

  log.info("sdk.run_role", { runId, role, model: args.model, resume: Boolean(existingSessionId), cwd });

  let capturedSessionId: string | undefined = existingSessionId ?? undefined;
  const assistantText: string[] = [];
  const metrics: RunMetrics = {
    costUsd: 0,
    numTurns: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  };

  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  let attemptErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assistantText.length = 0;
    attemptErr = null;

    // After a retry, resume whatever session id we captured on the aborted attempt.
    if (attempt > 1 && capturedSessionId) {
      options.resume = capturedSessionId;
    }

    // A fresh controller per attempt, linked to the caller's signal, so abort
    // actually stops the SDK subprocess instead of just abandoning it.
    const sdkAbort = new AbortController();
    const onAbort = () => sdkAbort.abort();
    if (signal) {
      if (signal.aborted) throw new Error("aborted");
      signal.addEventListener("abort", onAbort, { once: true });
    }
    options.abortController = sdkAbort;

    try {
      const q = query({ prompt: userPrompt, options: options as never });
      for await (const message of q as AsyncIterable<Record<string, unknown>>) {
        handleMessage(runId, role, message, {
          onSessionId: (id) => {
            capturedSessionId = id;
          },
          onAssistantText: (t) => assistantText.push(t),
          onResult: (r) => addResultMetrics(metrics, r),
        });
      }
      if (signal?.aborted) throw new Error("aborted");
      attemptErr = null;
      break;
    } catch (err) {
      attemptErr = signal?.aborted ? new Error("aborted") : err;
      const classification = classifyError(attemptErr);
      if (!classification.transient || attempt === maxAttempts) {
        log.error("sdk.run_failed", {
          runId,
          role,
          attempt,
          transient: classification.transient,
          err: attemptErr instanceof Error ? attemptErr.message : String(attemptErr),
        });
        if (capturedSessionId) saveSessionId(runId, role, capturedSessionId);
        throw attemptErr;
      }
      const wait = config.retry.initialDelayMs * Math.pow(2, attempt - 1);
      log.warn("sdk.retry", { runId, role, attempt, waitMs: wait, reason: classification.reason });
      emit({
        type: "role.message",
        runId,
        role,
        subtype: "system",
        text: `[orchestrator] transient error on attempt ${attempt}/${maxAttempts}, retrying in ${wait}ms: ${classification.reason}`,
      });
      await delay(wait);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  if (attemptErr) throw attemptErr;

  if (capturedSessionId) saveSessionId(runId, role, capturedSessionId);

  const full = assistantText.join("\n");
  const parsed = parseTerminalJsonBlock(full);

  if (!parsed.ok) {
    const hint = limitHint(metrics.resultSubtype);
    return { sessionId: capturedSessionId, parseError: parsed.reason + hint, metrics };
  }
  const validated = RoleOutputRawSchema.safeParse(parsed.value);
  if (!validated.success) {
    return {
      sessionId: capturedSessionId,
      parseError: `terminal JSON did not match schema: ${validated.error.message}`,
      metrics,
    };
  }
  return { sessionId: capturedSessionId, output: normalizeRoleOutput(validated.data), metrics };
}

function limitHint(subtype: string | undefined): string {
  if (subtype === "error_max_turns") return " (the role hit its maxTurns limit before finishing)";
  if (subtype === "error_max_budget_usd") return " (the role hit the run's cost budget before finishing)";
  return "";
}

function reportDenied(runId: string, role: RoleId, toolName: string, input: Record<string, unknown>, reason: string): void {
  const detail =
    toolName === "Bash"
      ? truncate(String(input.command ?? ""), 160)
      : truncate(String(input.file_path ?? input.notebook_path ?? ""), 160);
  log.warn("sdk.tool_denied", { runId, role, tool: toolName, detail, reason });
  emit({
    type: "role.message",
    runId,
    role,
    subtype: "system",
    text: `[orchestrator] blocked ${toolName}${detail ? ` (${detail})` : ""}: ${reason}`,
  });
}

function addResultMetrics(metrics: RunMetrics, r: Record<string, unknown>): void {
  if (typeof r.total_cost_usd === "number") metrics.costUsd += r.total_cost_usd;
  if (typeof r.num_turns === "number") metrics.numTurns += r.num_turns;
  if (typeof r.subtype === "string") metrics.resultSubtype = r.subtype;
  const u = (r.usage ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  metrics.usage.inputTokens += n("input_tokens");
  metrics.usage.outputTokens += n("output_tokens");
  metrics.usage.cacheReadInputTokens += n("cache_read_input_tokens");
  metrics.usage.cacheCreationInputTokens += n("cache_creation_input_tokens");
}

interface MessageHandlers {
  onSessionId: (id: string) => void;
  onAssistantText: (text: string) => void;
  onResult: (result: Record<string, unknown>) => void;
}

function handleMessage(
  runId: string,
  role: RoleId,
  message: Record<string, unknown>,
  handlers: MessageHandlers,
): void {
  const type = message.type as string | undefined;

  if (type === "system") {
    const sid = (message as { session_id?: string }).session_id;
    if (sid) handlers.onSessionId(sid);
    return;
  }

  if (type === "result") {
    const sid = (message as { session_id?: string }).session_id;
    if (sid) handlers.onSessionId(sid);
    handlers.onResult(message);
    return;
  }

  if (type === "assistant") {
    const inner = (message as { message?: { content?: unknown } }).message?.content ?? message.content;
    const blocks = Array.isArray(inner) ? inner : [];
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        handlers.onAssistantText(b.text);
        emit({ type: "role.message", runId, role, text: b.text, subtype: "assistant" });
      } else if (b.type === "tool_use") {
        const id = String(b.id ?? "");
        const name = String(b.name ?? "");
        emit({
          type: "role.tool_call",
          runId,
          role,
          name,
          input: b.input ?? {},
          toolUseId: id,
        });
      }
    }
    return;
  }

  if (type === "user") {
    const inner = (message as { message?: { content?: unknown } }).message?.content ?? message.content;
    const blocks = Array.isArray(inner) ? inner : [];
    for (const block of blocks) {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_result") {
        const id = String(b.tool_use_id ?? "");
        const isError = Boolean(b.is_error);
        const content = b.content;
        const summary = typeof content === "string" ? truncate(content, 500) : truncate(JSON.stringify(content ?? ""), 500);
        emit({
          type: "role.tool_result",
          runId,
          role,
          toolUseId: id,
          isError,
          summary,
        });
      }
    }
    return;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...<truncated>";
}

type ParseResult = { ok: true; value: unknown } | { ok: false; reason: string };

export function parseTerminalJsonBlock(text: string): ParseResult {
  if (!text.trim()) return { ok: false, reason: "assistant produced no text" };

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    const body = m[1];
    if (body !== undefined) matches.push(body.trim());
  }
  const candidates = matches.length > 0 ? matches : [text.trim()];

  for (let i = candidates.length - 1; i >= 0; i--) {
    const raw = candidates[i];
    if (raw === undefined) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && "status" in parsed) {
        return { ok: true, value: parsed };
      }
    } catch {
      // keep trying
    }
  }

  return { ok: false, reason: "no fenced JSON block with a `status` field was found at the end of the role's response" };
}

export function classifyError(err: unknown): { transient: boolean; reason: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower === "aborted") return { transient: false, reason: "aborted" };
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.*api.*key|authentication/.test(lower)) {
    return { transient: false, reason: `auth error: ${truncate(msg, 100)}` };
  }
  if (/\b4\d\d\b|bad.?request|not.?found/.test(lower)) {
    return { transient: false, reason: `client error: ${truncate(msg, 100)}` };
  }
  if (/econnreset|etimedout|econnrefused|enotfound|socket hang up|network/.test(lower)) {
    return { transient: true, reason: `network: ${truncate(msg, 100)}` };
  }
  if (/\b5\d\d\b|server error|internal error|overloaded|rate.?limit|too many requests/.test(lower)) {
    return { transient: true, reason: `upstream: ${truncate(msg, 100)}` };
  }
  if (/timed? ?out|timeout/.test(lower)) {
    return { transient: true, reason: `timeout: ${truncate(msg, 100)}` };
  }
  // Default: treat unknown errors as non-transient so we don't retry a bug.
  return { transient: false, reason: truncate(msg, 100) };
}
