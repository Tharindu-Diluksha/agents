import { beforeEach, describe, expect, it, vi } from "vitest";

/* Runs runRoleAgent / postJiraComment against a fake SDK message stream. */

let messages: Array<Record<string, unknown>> = [];
const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push({ prompt, options });
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }),
}));
vi.mock("../src/orchestrator/sessionStore.js", () => ({ getSessionId: () => null, saveSessionId: () => undefined }));

const { runRoleAgent } = await import("../src/sdk/runRole.js");
const { postJiraComment } = await import("../src/external/jiraMcp.js");
const { subscribeAll } = await import("../src/events.js");
const { roles } = await import("../src/roles/index.js");

const usage = (input: number, output: number, cacheRead = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: 0,
});
const assistant = (id: string, u: ReturnType<typeof usage>, text?: string) => ({
  type: "assistant",
  message: { id, usage: u, content: text ? [{ type: "text", text }] : [] },
});

beforeEach(() => {
  queryCalls.length = 0;
});

describe("runRoleAgent token usage", () => {
  it("emits live usage per API call (deduped by message id) and final usage from the result", async () => {
    messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      assistant("msg_1", usage(100, 10, 50)),
      assistant("msg_1", usage(100, 20, 50)), // same API call, later chunk
      assistant("msg_2", usage(200, 30), '```json\n{"status":"done","artifacts":[],"approvalRequest":null,"handoff":null}\n```'),
      { type: "result", subtype: "success", session_id: "sess-1", total_cost_usd: 0.12, num_turns: 2, usage: usage(300, 50, 50) },
    ];
    const events: Array<Record<string, unknown>> = [];
    const off = subscribeAll((e) => {
      if (e.type === "role.usage") events.push(e as unknown as Record<string, unknown>);
    });
    const res = await runRoleAgent({
      runId: "R",
      role: "developer",
      spec: roles.developer,
      systemPrompt: "s",
      userPrompt: "u",
      cwd: "/repo",
      model: "claude-sonnet-5-5",
      repoPaths: ["/repo"],
      writeRoots: ["/repo"],
      bashAllowList: roles.developer.bashAllowList,
    });
    off();

    expect(res.output?.status).toBe("done");
    expect(res.metrics).toMatchObject({ costUsd: 0.12, numTurns: 2, resultSubtype: "success" });
    expect(res.metrics!.usage).toEqual({ inputTokens: 300, outputTokens: 50, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 });

    const live = events.filter((e) => !e.final).map((e) => (e.usage as { outputTokens: number }).outputTokens);
    expect(live).toEqual([10, 20, 50]); // msg_1 counted once, at its latest value
    const final = events.find((e) => e.final)!;
    expect(final.usage).toEqual(res.metrics!.usage);
    expect(final.costUsd).toBe(0.12);
  });

  it("attaches MCP servers and auto-approves only read-only tools", async () => {
    messages = [{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 0, usage: usage(0, 0) }];
    await runRoleAgent({
      runId: "R",
      role: "analyst",
      spec: roles.analyst,
      systemPrompt: "s",
      userPrompt: "u",
      cwd: "/runs/R/analyst",
      model: "m",
      repoPaths: ["/repo"],
      writeRoots: ["/runs/R"],
      bashAllowList: [],
      extraTools: ["mcp__jira__getJiraIssue"],
      mcpServers: { jira: { type: "http", url: "https://x" } },
    });
    const opts = queryCalls[0]!.options;
    expect(opts.mcpServers).toEqual({ jira: { type: "http", url: "https://x" } });
    expect(opts.tools).toEqual(["Read", "Glob", "Grep", "Write", "Edit"]);
    expect(opts.allowedTools).toEqual(["Read", "Glob", "Grep", "mcp__jira__getJiraIssue"]);
    expect(opts.model).toBe("m");
  });
});

describe("postJiraComment", () => {
  const prevEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...prevEnv, JIRA_MCP_URL: "https://mcp.example.com/mcp", JIRA_MCP_SERVER_NAME: "jira" };
  });

  it("succeeds only when the add-comment tool returned without error", async () => {
    messages = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__jira__addCommentToJiraIssue", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "ok" }] } },
    ];
    await expect(postJiraComment("PROJ-1", "hello")).resolves.toBeUndefined();
    const opts = queryCalls[0]!.options;
    expect(opts.tools).toEqual([]);
    expect(opts.allowedTools).toEqual(["mcp__jira__addCommentToJiraIssue"]);
    expect(opts.mcpServers).toEqual({ jira: { type: "http", url: "https://mcp.example.com/mcp", headers: undefined } });
  });

  it("throws when the tool errored or was never called", async () => {
    messages = [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__jira__addCommentToJiraIssue", input: {} }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "401 Unauthorized" }] } },
    ];
    await expect(postJiraComment("PROJ-1", "hello")).rejects.toThrow(/401 Unauthorized/);
    messages = [{ type: "assistant", message: { content: [{ type: "text", text: "DONE" }] } }];
    await expect(postJiraComment("PROJ-1", "hello")).rejects.toThrow(/never called/);
  });

  it("throws when JIRA MCP is not configured", async () => {
    process.env = { ...prevEnv };
    delete process.env.JIRA_MCP_URL;
    delete process.env.JIRA_MCP_COMMAND;
    await expect(postJiraComment("PROJ-1", "hello")).rejects.toThrow(/not configured/);
  });
});
