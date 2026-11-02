import { query } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../config.js";
import { emit } from "../events.js";
import { log } from "../log.js";
import { getSessionId, saveSessionId } from "../orchestrator/sessionStore.js";
import type { RoleId, RoleOutput } from "../orchestrator/types.js";
import type { RoleSpec } from "../roles/types.js";

// Zod schema accepts both the preferred payloadPaths (string[]) and the legacy
// scalar payloadPath that older role prompts may still emit. We normalize to
// payloadPaths before handing the value out.
const RoleOutputRawSchema = z.object({
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
      nextRole: z.enum(["analyst", "developer", "reviewer", "tester", "prCreator"]),
      notes: z.string().optional(),
    })
    .nullable(),
});

function normalizeRoleOutput(raw: z.infer<typeof RoleOutputRawSchema>): RoleOutput {
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
    handoff: raw.handoff,
  };
}

export interface RunRoleAgentArgs {
  runId: string;
  role: RoleId;
  spec: RoleSpec;
  systemPrompt: string;
  userPrompt: string;
  cwd: string;
  /** Absolute paths of all repos in the run. Bash commands can be prefixed with `cd <any-of-these> && ` and still pass the allowlist. */
  repoPaths: string[];
  signal?: AbortSignal;
}

export interface RunRoleAgentResult {
  sessionId?: string;
  output?: RoleOutput;
  parseError?: string;
}

/**
 * Runs a role in a Claude Agent SDK session, streaming to the event bus,
 * persisting the SDK session id, and parsing the terminal JSON block.
 *
 * On re-run (sessionStore returns an existing id for runId+role), the SDK is
 * invoked with `resume: <sessionId>` so the role sees its prior attempt.
 */
export async function runRoleAgent(args: RunRoleAgentArgs): Promise<RunRoleAgentResult> {
  const { runId, role, spec, systemPrompt, userPrompt, cwd, repoPaths, signal } = args;
  const existingSessionId = getSessionId(runId, role);

  const canUseTool = buildCanUseTool(runId, role, spec, repoPaths);

  const options: Record<string, unknown> = {
    cwd,
    model: config.model,
    systemPrompt,
    allowedTools: spec.allowedTools,
    permissionMode: "default",
    canUseTool,
    maxTurns: spec.maxTurns ?? 40,
    settingSources: [],
  };
  if (existingSessionId) options.resume = existingSessionId;

  log.info("sdk.run_role", { runId, role, resume: Boolean(existingSessionId), cwd });

  let capturedSessionId: string | undefined = existingSessionId ?? undefined;
  const assistantText: string[] = [];
  const toolCallsById = new Map<string, { name: string }>();

  const maxAttempts = Math.max(1, config.retry.maxAttempts);
  let attemptErr: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    assistantText.length = 0;
    toolCallsById.clear();
    attemptErr = null;

    // After a retry, resume whatever session id we captured on the aborted attempt.
    if (attempt > 1 && capturedSessionId) {
      (options as Record<string, unknown>).resume = capturedSessionId;
    }

    try {
      const q = query({ prompt: userPrompt, options: options as never });

      const abortPromise = signal
        ? new Promise<never>((_, reject) => {
            const onAbort = () => reject(new Error("aborted"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          })
        : null;

      const iterator = (async () => {
        for await (const message of q as AsyncIterable<Record<string, unknown>>) {
          handleMessage(runId, role, message, {
            onSessionId: (id) => {
              capturedSessionId = id;
            },
            onAssistantText: (t) => assistantText.push(t),
            onToolCall: (id, name) => toolCallsById.set(id, { name }),
            onToolResult: () => {
              /* already emitted inside handleMessage */
            },
          });
        }
      })();

      await (abortPromise ? Promise.race([iterator, abortPromise]) : iterator);
      attemptErr = null;
      break;
    } catch (err) {
      attemptErr = err;
      const classification = classifyError(err);
      if (!classification.transient || attempt === maxAttempts) {
        log.error("sdk.run_failed", {
          runId,
          role,
          attempt,
          transient: classification.transient,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
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
    }
  }

  if (attemptErr) throw attemptErr;

  if (capturedSessionId) saveSessionId(runId, role, capturedSessionId);

  const full = assistantText.join("\n");
  const parsed = parseTerminalJsonBlock(full);

  if (!parsed.ok) {
    return { sessionId: capturedSessionId, parseError: parsed.reason };
  }
  const validated = RoleOutputRawSchema.safeParse(parsed.value);
  if (!validated.success) {
    return {
      sessionId: capturedSessionId,
      parseError: `terminal JSON did not match schema: ${validated.error.message}`,
    };
  }
  return { sessionId: capturedSessionId, output: normalizeRoleOutput(validated.data) };
}

interface MessageHandlers {
  onSessionId: (id: string) => void;
  onAssistantText: (text: string) => void;
  onToolCall: (id: string, name: string) => void;
  onToolResult: () => void;
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
        handlers.onToolCall(id, name);
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
        handlers.onToolResult();
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

function parseTerminalJsonBlock(text: string): ParseResult {
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

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options?: unknown,
) => Promise<
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string }
>;

function classifyError(err: unknown): { transient: boolean; reason: string } {
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

function buildCanUseTool(runId: string, role: RoleId, spec: RoleSpec, repoPaths: string[]): CanUseToolFn {
  const bashAllow = spec.bashAllowList ?? [];
  return async (toolName, input) => {
    if (toolName === "Bash") {
      const cmd = typeof input.command === "string" ? input.command.trim() : "";
      const effective = stripCdPrefix(cmd, repoPaths);
      const ok = bashAllow.some((re) => re.test(effective));
      if (!ok) {
        const msg = `Bash command not allowed for ${role}: ${truncate(cmd, 160)}`;
        log.warn("sdk.bash_denied", { runId, role, cmd: truncate(cmd, 160) });
        emit({
          type: "role.message",
          runId,
          role,
          text: `[orchestrator] blocked Bash command (not in ${role} allowlist): ${truncate(cmd, 160)}`,
          subtype: "system",
        });
        return { behavior: "deny", message: msg };
      }
    }
    return { behavior: "allow" };
  };
}

/**
 * If the command is of the form `cd <path> && <rest>` where <path> matches one
 * of the run's repo paths (bare, quoted with ', or quoted with "), returns the
 * `<rest>` portion so the per-role allowlist can validate it. Otherwise
 * returns the command unchanged.
 */
function stripCdPrefix(cmd: string, repoPaths: string[]): string {
  const match = cmd.match(/^cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*(.+)$/);
  if (!match) return cmd;
  const rawPath = match[1]!;
  const rest = match[2]!.trim();
  const unquoted = rawPath.replace(/^['"]|['"]$/g, "");
  const normalized = unquoted.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const repo of repoPaths) {
    const norm = repo.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (norm === normalized) return rest;
  }
  return cmd;
}
