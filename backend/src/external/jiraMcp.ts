import { query } from "@anthropic-ai/claude-agent-sdk";
import { log } from "../log.js";

/**
 * Posts a comment on a JIRA ticket via the `atlassian-local` MCP server.
 *
 * We spin up a short Agent SDK session with only the write tool allowed,
 * instructing the model to call the MCP tool with the exact payload. This
 * reuses the user's existing MCP auth without reinventing an atlassian HTTP
 * client here.
 */
export async function postJiraComment(ticket: string, body: string): Promise<void> {
  const prompt = [
    `Post a single comment on JIRA issue ${ticket}.`,
    `Call the tool mcp__atlassian-local__addCommentToJiraIssue exactly once with the issue key \`${ticket}\` and the body text delimited below.`,
    `Do not say anything else. Do not rewrite the body. After the tool call succeeds, respond with the single word DONE.`,
    "",
    "<<<COMMENT_BODY_BEGIN>>>",
    body,
    "<<<COMMENT_BODY_END>>>",
  ].join("\n");

  const options = {
    allowedTools: ["mcp__atlassian-local__addCommentToJiraIssue"],
    permissionMode: "default" as const,
    maxTurns: 4,
    settingSources: [],
  };

  let sawDone = false;
  for await (const message of query({ prompt, options: options as never }) as AsyncIterable<Record<string, unknown>>) {
    if (message.type === "assistant") {
      const inner = (message as { message?: { content?: unknown } }).message?.content ?? message.content;
      const blocks = Array.isArray(inner) ? inner : [];
      for (const b of blocks) {
        const block = b as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string" && /\bDONE\b/.test(block.text)) {
          sawDone = true;
        }
      }
    }
  }
  if (!sawDone) {
    log.warn("jiraMcp.no_done_signal", { ticket });
  }
}
