import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { paths } from "../config.js";

/**
 * JIRA MCP server configuration.
 *
 * Sources, in order (later ones override earlier ones field by field):
 *   1. A JSON file: `JIRA_MCP_CONFIG` (path, relative to the orchestrator root),
 *      or `jira-mcp.json` at the orchestrator root if it exists.
 *   2. Environment variables (`JIRA_MCP_*`, see `.env.example`).
 *
 * String values in `server` (command, args, env, url, headers) may reference
 * environment variables as `${NAME}`, so tokens can stay in `.env`.
 *
 * Tool names differ between JIRA MCP servers (e.g. Atlassian's remote server
 * uses `getJiraIssue`; others use `jira_get_issue`), so they are configurable.
 */

const ServerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("http"),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
  }),
  z.object({
    type: z.literal("sse"),
    url: z.string().min(1),
    headers: z.record(z.string()).optional(),
  }),
]);
export type JiraMcpServer = z.infer<typeof ServerSchema>;

const ToolsSchema = z.object({
  /** Fetch one issue by key. Given to the Analyst and the Developer. */
  getIssue: z.string().min(1),
  /** JQL search. Given to the Analyst. */
  searchIssues: z.string().min(1).nullable(),
  /** Add a comment. Only the orchestrator uses it, after the user approves. */
  addComment: z.string().min(1),
  /** Other read-only tools the Analyst may call (e.g. resource / user lookups). */
  readOnlyExtras: z.array(z.string().min(1)),
});
export type JiraMcpTools = z.infer<typeof ToolsSchema>;

export interface JiraMcpConfig {
  /** MCP server name; tools are exposed to the model as `mcp__<serverName>__<tool>`. */
  serverName: string;
  server: JiraMcpServer;
  tools: JiraMcpTools;
  /** Where the config came from, for display. */
  source: string;
}

/** Defaults match Atlassian's remote MCP server (also when proxied locally via mcp-remote). */
export const DEFAULT_JIRA_TOOLS: JiraMcpTools = {
  getIssue: "getJiraIssue",
  searchIssues: "searchJiraIssuesUsingJql",
  addComment: "addCommentToJiraIssue",
  readOnlyExtras: ["getAccessibleAtlassianResources", "atlassianUserInfo"],
};

const FileSchema = z.object({
  serverName: z.string().regex(/^[A-Za-z0-9_-]+$/).optional(),
  server: z.unknown().optional(),
  tools: ToolsSchema.partial().optional(),
});

export class JiraMcpConfigError extends Error {}

/**
 * Loads the config fresh on every call (it's a small file), so edits take
 * effect without restarting the backend. Returns null when nothing is
 * configured; throws JiraMcpConfigError when the config is present but invalid.
 */
export function loadJiraMcpConfig(env: NodeJS.ProcessEnv = process.env): JiraMcpConfig | null {
  const fileRef = env.JIRA_MCP_CONFIG?.trim();
  const filePath = fileRef ? (isAbsolute(fileRef) ? fileRef : resolve(paths.repoRoot, fileRef)) : resolve(paths.repoRoot, "jira-mcp.json");

  let file: z.infer<typeof FileSchema> = {};
  let source = "env";
  if (existsSync(filePath)) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new JiraMcpConfigError(`${filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = FileSchema.safeParse(raw);
    if (!parsed.success) throw new JiraMcpConfigError(`${filePath}: ${parsed.error.message}`);
    file = parsed.data;
    source = `file: ${filePath}`;
  } else if (fileRef) {
    throw new JiraMcpConfigError(`JIRA_MCP_CONFIG points to ${filePath}, which does not exist`);
  }

  const serverFromEnv = serverFromEnvVars(env);
  const rawServer = serverFromEnv ?? file.server;
  if (!rawServer) return null;
  if (serverFromEnv && source !== "env") source = `${source} + env`;

  const serverParsed = ServerSchema.safeParse(normalizeServer(rawServer));
  if (!serverParsed.success) throw new JiraMcpConfigError(`invalid JIRA MCP server config: ${serverParsed.error.message}`);

  const serverName = env.JIRA_MCP_SERVER_NAME?.trim() || file.serverName || "atlassian-local";
  if (!/^[A-Za-z0-9_-]+$/.test(serverName)) {
    throw new JiraMcpConfigError(`JIRA MCP server name "${serverName}" may only contain letters, digits, _ and -`);
  }

  const tools: JiraMcpTools = {
    getIssue: env.JIRA_MCP_TOOL_GET_ISSUE?.trim() || file.tools?.getIssue || DEFAULT_JIRA_TOOLS.getIssue,
    searchIssues:
      env.JIRA_MCP_TOOL_SEARCH !== undefined
        ? env.JIRA_MCP_TOOL_SEARCH.trim() || null
        : file.tools?.searchIssues !== undefined
        ? file.tools.searchIssues
        : DEFAULT_JIRA_TOOLS.searchIssues,
    addComment: env.JIRA_MCP_TOOL_ADD_COMMENT?.trim() || file.tools?.addComment || DEFAULT_JIRA_TOOLS.addComment,
    readOnlyExtras:
      env.JIRA_MCP_TOOLS_READ_EXTRA !== undefined
        ? splitList(env.JIRA_MCP_TOOLS_READ_EXTRA)
        : file.tools?.readOnlyExtras ?? DEFAULT_JIRA_TOOLS.readOnlyExtras,
  };

  return { serverName, server: expandServer(serverParsed.data, env), tools, source };
}

function serverFromEnvVars(env: NodeJS.ProcessEnv): unknown | null {
  const command = env.JIRA_MCP_COMMAND?.trim();
  const url = env.JIRA_MCP_URL?.trim();
  if (command) {
    return {
      type: "stdio",
      command,
      args: parseJsonEnv(env, "JIRA_MCP_ARGS", []),
      env: parseJsonEnv(env, "JIRA_MCP_ENV", undefined),
    };
  }
  if (url) {
    return {
      type: (env.JIRA_MCP_TRANSPORT?.trim() || "http").toLowerCase(),
      url,
      headers: parseJsonEnv(env, "JIRA_MCP_HEADERS", undefined),
    };
  }
  return null;
}

function parseJsonEnv<T>(env: NodeJS.ProcessEnv, name: string, fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new JiraMcpConfigError(`${name} must be JSON (e.g. ${name === "JIRA_MCP_ARGS" ? '["-y","mcp-remote","https://..."]' : '{"KEY":"value"}'})`);
  }
}

/** Accepts the Claude Code `.mcp.json` shape, where `type` is optional for stdio servers. */
function normalizeServer(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !("type" in raw) && "command" in raw) {
    return { type: "stdio", ...(raw as object) };
  }
  return raw;
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Replaces `${NAME}` with the environment variable's value (empty if unset). */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

function expandRecord(rec: Record<string, string> | undefined, env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!rec) return undefined;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandEnvRefs(v, env)]));
}

function expandServer(server: JiraMcpServer, env: NodeJS.ProcessEnv): JiraMcpServer {
  if (server.type === "stdio") {
    return {
      type: "stdio",
      command: expandEnvRefs(server.command, env),
      args: server.args.map((a) => expandEnvRefs(a, env)),
      // A stdio server inherits nothing unless we pass it, so keep PATH etc.
      env: server.env ? { ...stringEnv(env), ...expandRecord(server.env, env) } : undefined,
    };
  }
  return { type: server.type, url: expandEnvRefs(server.url, env), headers: expandRecord(server.headers, env) };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
}

/** Fully-qualified tool name as the model sees it. */
export function qualifiedTool(cfg: JiraMcpConfig, tool: string): string {
  return `mcp__${cfg.serverName}__${tool}`;
}

export type JiraAccess = "issue" | "read";

/** Qualified tool names for a role's JIRA access level. Never includes the write tool. */
export function jiraToolsFor(cfg: JiraMcpConfig, access: JiraAccess): string[] {
  const names =
    access === "issue"
      ? [cfg.tools.getIssue]
      : [cfg.tools.getIssue, ...(cfg.tools.searchIssues ? [cfg.tools.searchIssues] : []), ...cfg.tools.readOnlyExtras];
  return [...new Set(names)].filter((n) => n !== cfg.tools.addComment).map((n) => qualifiedTool(cfg, n));
}

/** SDK `mcpServers` option for this config. */
export function mcpServersOption(cfg: JiraMcpConfig): Record<string, JiraMcpServer> {
  return { [cfg.serverName]: cfg.server };
}

/** Safe description for the UI: never includes env, headers, args or URL query strings (they may hold secrets). */
export interface JiraMcpSummary {
  configured: boolean;
  error?: string;
  serverName?: string;
  transport?: JiraMcpServer["type"];
  /** Command name (stdio) or URL origin + path (http/sse). */
  target?: string;
  source?: string;
  tools?: JiraMcpTools;
}

export function describeJiraMcp(): JiraMcpSummary {
  let cfg: JiraMcpConfig | null;
  try {
    cfg = loadJiraMcpConfig();
  } catch (err) {
    return { configured: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!cfg) return { configured: false };
  let target: string;
  if (cfg.server.type === "stdio") {
    target = cfg.server.command;
  } else {
    try {
      const u = new URL(cfg.server.url);
      target = `${u.origin}${u.pathname}`;
    } catch {
      target = "(invalid URL)";
    }
  }
  return { configured: true, serverName: cfg.serverName, transport: cfg.server.type, target, source: cfg.source, tools: cfg.tools };
}
