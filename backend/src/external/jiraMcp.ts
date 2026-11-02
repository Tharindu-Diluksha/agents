import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "../config.js";
import { log } from "../log.js";
import {
  JiraMcpConfigError,
  loadJiraMcpConfig,
  mcpServersOption,
  qualifiedTool,
  type JiraMcpConfig,
} from "./jiraMcpConfig.js";

function requireConfig(): JiraMcpConfig {
  const cfg = loadJiraMcpConfig();
  if (!cfg) throw new JiraMcpConfigError("JIRA MCP server is not configured (see JIRA_MCP_* in .env.example or jira-mcp.example.json)");
  return cfg;
}

/**
 * Posts a comment on a JIRA ticket via the configured JIRA MCP server.
 *
 * We spin up a short Agent SDK session whose only tool is the MCP add-comment
 * tool, and instruct the model to call it with the exact payload. This reuses
 * the MCP server's auth without an Atlassian HTTP client here.
 *
 * Succeeds only if the add-comment tool was called and returned without
 * error; otherwise throws, so the orchestrator keeps the approval gate open.
 */
export async function postJiraComment(ticket: string, body: string): Promise<void> {
  const cfg = requireConfig();
  const tool = qualifiedTool(cfg, cfg.tools.addComment);
  const prompt = [
    `Post a single comment on JIRA issue ${ticket}.`,
    `Call the tool ${tool} exactly once with the issue key \`${ticket}\` and the body text delimited below. If the tool needs a cloud id / site id, use the one for the site in the issue URL or the only accessible site.`,
    `Do not rewrite the body. After the tool call succeeds, respond with the single word DONE.`,
    "",
    "<<<COMMENT_BODY_BEGIN>>>",
    body,
    "<<<COMMENT_BODY_END>>>",
  ].join("\n");

  const options = {
    model: config.model,
    tools: [] as string[], // no built-in tools
    mcpServers: mcpServersOption(cfg),
    allowedTools: [tool],
    permissionMode: "default" as const,
    canUseTool: async (name: string, input: Record<string, unknown>) =>
      name === tool
        ? { behavior: "allow" as const, updatedInput: input }
        : { behavior: "deny" as const, message: "only the add-comment tool is allowed" },
    maxTurns: 4,
    settingSources: [],
  };

  const callIds = new Set<string>();
  let succeeded = false;
  let lastError: string | null = null;
  for await (const message of query({ prompt, options: options as never }) as AsyncIterable<Record<string, unknown>>) {
    const inner = (message as { message?: { content?: unknown } }).message?.content;
    const blocks = Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : [];
    if (message.type === "assistant") {
      for (const b of blocks) if (b.type === "tool_use" && b.name === tool) callIds.add(String(b.id));
    } else if (message.type === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result" || !callIds.has(String(b.tool_use_id))) continue;
        if (b.is_error) lastError = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        else succeeded = true;
      }
    }
  }
  if (!succeeded) {
    const reason = lastError ?? (callIds.size === 0 ? `the model never called ${tool}` : "no successful tool result");
    log.warn("jiraMcp.comment_not_posted", { ticket, reason });
    throw new Error(`JIRA comment not posted: ${reason}`);
  }
}

export interface JiraMcpTestResult {
  ok: boolean;
  serverName?: string;
  /** Connection status reported by the SDK: connected | failed | needs-auth | pending. */
  status?: string;
  /** Configured tools the server actually exposes. */
  toolsFound: string[];
  /** Configured tools the server does not expose (wrong names in config?). */
  toolsMissing: string[];
  /** All tools the server exposes, to help fix tool-name config. */
  serverTools: string[];
  error?: string;
}

/**
 * Starts an SDK session with only the JIRA MCP server attached, reads the
 * `system/init` message (which lists MCP server status and tools), then
 * aborts before the model does any real work.
 */
export async function testJiraMcp(timeoutMs = 60_000): Promise<JiraMcpTestResult> {
  let cfg: JiraMcpConfig;
  try {
    cfg = requireConfig();
  } catch (err) {
    return { ok: false, toolsFound: [], toolsMissing: [], serverTools: [], error: err instanceof Error ? err.message : String(err) };
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  const prefix = `mcp__${cfg.serverName}__`;
  try {
    const q = query({
      prompt: "Reply with OK.",
      options: {
        model: config.model,
        tools: [],
        mcpServers: mcpServersOption(cfg),
        maxTurns: 1,
        settingSources: [],
        abortController: abort,
      } as never,
    }) as AsyncIterable<Record<string, unknown>>;

    for await (const message of q) {
      if (message.type !== "system" || message.subtype !== "init") continue;
      const servers = (message.mcp_servers ?? []) as Array<{ name: string; status: string }>;
      const status = servers.find((s) => s.name === cfg.serverName)?.status ?? "missing";
      const serverTools = ((message.tools ?? []) as string[]).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
      const wanted = [cfg.tools.getIssue, cfg.tools.addComment, ...(cfg.tools.searchIssues ? [cfg.tools.searchIssues] : []), ...cfg.tools.readOnlyExtras];
      const toolsFound = wanted.filter((t) => serverTools.includes(t));
      const toolsMissing = wanted.filter((t) => !serverTools.includes(t));
      abort.abort();
      const required = [cfg.tools.getIssue, cfg.tools.addComment];
      return {
        ok: status === "connected" && required.every((t) => serverTools.includes(t)),
        serverName: cfg.serverName,
        status,
        toolsFound,
        toolsMissing,
        serverTools,
      };
    }
    return { ok: false, serverName: cfg.serverName, toolsFound: [], toolsMissing: [], serverTools: [], error: "no init message from the SDK" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      serverName: cfg.serverName,
      toolsFound: [],
      toolsMissing: [],
      serverTools: [],
      error: abort.signal.aborted ? `timed out after ${timeoutMs / 1000}s` : msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
