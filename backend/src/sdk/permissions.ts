import { isAbsolute, relative, resolve } from "node:path";

/**
 * Tool-use guard shared by the SDK `canUseTool` callback and the `PreToolUse`
 * hook. Pure functions only so they can be unit-tested without the SDK.
 */

/** Tools that mutate the machine and must always pass through the guard. */
export const GATED_TOOLS = new Set(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"]);

export type GuardDecision = { allow: true } | { allow: false; reason: string };

export interface GuardContext {
  /** Every tool the role may use (built-in and MCP). Anything else is denied. */
  allowedTools: string[];
  bashAllowList: RegExp[];
  /** Absolute paths of the run's target repos (used by the `cd <repo> && …` prefix). */
  repoPaths: string[];
  /** Absolute directories file-writing tools may touch. */
  writeRoots: string[];
  /** cwd of the SDK session, used to resolve relative file paths. */
  cwd: string;
}

export function evaluateToolUse(toolName: string, input: Record<string, unknown>, ctx: GuardContext): GuardDecision {
  if (!ctx.allowedTools.includes(toolName)) {
    return { allow: false, reason: `tool ${toolName} is not in this role's allowlist` };
  }
  if (toolName === "Bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return checkBashCommand(cmd, ctx.bashAllowList, ctx.repoPaths);
  }
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return checkWritePath(input.file_path, ctx.writeRoots, ctx.cwd);
  }
  if (toolName === "NotebookEdit") {
    return checkWritePath(input.notebook_path, ctx.writeRoots, ctx.cwd);
  }
  return { allow: true };
}

/** Arguments that let an otherwise-allowed command write files or run arbitrary programs. */
const DANGEROUS_ARGS = [/(^|\s)--output(=|\s|$)/, /(^|\s)--upload-pack\b/, /(^|\s)--receive-pack\b/, /(^|\s)--exec\b/, /(^|\s)-c\s+core\./];

/**
 * Validates a Bash command against a role's allowlist.
 *
 * - Exactly one command is allowed. Shell operators (`;`, `&&`, `||`, `|`,
 *   `&`, redirects, command substitution, newlines) are rejected unless they
 *   sit inside single quotes, or (for operators other than substitution)
 *   inside double quotes. This closes the `git status; rm -rf ~` bypass the
 *   start-anchored allowlist regexes otherwise allow.
 * - A leading `cd <repo> && ` is permitted when `<repo>` is one of the run's
 *   repos; the remainder is what gets checked.
 * - A trailing `2>&1` is tolerated.
 */
export function checkBashCommand(raw: string, allowList: RegExp[], repoPaths: string[]): GuardDecision {
  let cmd = raw.trim();
  if (!cmd) return { allow: false, reason: "empty command" };
  if (/[\r\n]/.test(cmd)) return { allow: false, reason: "multi-line commands are not allowed" };

  cmd = stripCdPrefix(cmd, repoPaths);
  cmd = cmd.replace(/\s+2>&1$/, "");

  const meta = findShellOperator(cmd);
  if (meta) return { allow: false, reason: `shell operator ${JSON.stringify(meta)} is not allowed; run one command at a time` };

  if (DANGEROUS_ARGS.some((re) => re.test(cmd))) {
    return { allow: false, reason: "argument not allowed (can write files or execute programs)" };
  }
  if (!allowList.some((re) => re.test(cmd))) {
    return { allow: false, reason: "command is not in this role's Bash allowlist" };
  }
  return { allow: true };
}

/**
 * Returns the first shell operator found outside quotes, or null. Command
 * substitution (`$(` and backticks) is also rejected inside double quotes,
 * because the shell expands it there. Unbalanced quotes are treated as unsafe.
 */
export function findShellOperator(cmd: string): string | null {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (c === "\\") {
      i++; // escaped character is literal
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "`") return "`";
      else if (c === "$" && next === "(") return "$(";
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "`") return "`";
    if (c === "$" && next === "(") return "$(";
    if (c === ";" || c === "|" || c === "&" || c === "<" || c === ">") {
      return next === c ? c + c : c;
    }
  }
  return quote ? `unbalanced ${quote}` : null;
}

/**
 * If the command is `cd <path> && <rest>` and <path> is one of the run's repos
 * (bare or quoted), returns `<rest>`. Otherwise returns the command unchanged,
 * so the `&&` is then rejected as a shell operator.
 */
export function stripCdPrefix(cmd: string, repoPaths: string[]): string {
  const match = cmd.match(/^cd\s+((?:"[^"]+")|(?:'[^']+')|(?:\S+))\s*&&\s*(.+)$/);
  if (!match) return cmd;
  const rawPath = match[1]!;
  const rest = match[2]!.trim();
  const unquoted = rawPath.replace(/^['"]|['"]$/g, "");
  const normalized = normalizePath(unquoted);
  for (const repo of repoPaths) {
    if (normalizePath(repo) === normalized) return rest;
  }
  return cmd;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Allows a file write only when the target lies inside one of `roots`, and
 * never inside a `.git` directory.
 */
export function checkWritePath(filePath: unknown, roots: string[], cwd: string): GuardDecision {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    return { allow: false, reason: "missing file path" };
  }
  const abs = resolve(cwd, filePath);
  const segments = abs.split(/[\\/]/);
  if (segments.includes(".git")) {
    return { allow: false, reason: `writes inside .git are not allowed: ${abs}` };
  }
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  for (const root of roots) {
    const a = caseInsensitive ? abs.toLowerCase() : abs;
    const r = caseInsensitive ? resolve(root).toLowerCase() : resolve(root);
    const rel = relative(r, a);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return { allow: true };
  }
  return { allow: false, reason: `path is outside this role's write scope: ${abs}` };
}
