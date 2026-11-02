import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "jira-cfg-"));
});

vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return { ...orig, paths: { ...orig.paths, repoRoot: tmp } };
});

const { DEFAULT_JIRA_TOOLS, describeJiraMcp, expandEnvRefs, jiraToolsFor, loadJiraMcpConfig, mcpServersOption } = await import(
  "../src/external/jiraMcpConfig.js"
);

const file = join(tmp, "jira-mcp.json");
beforeEach(() => rmSync(file, { force: true }));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("loadJiraMcpConfig", () => {
  it("returns null when nothing is configured", () => {
    expect(loadJiraMcpConfig({})).toBeNull();
  });

  it("reads jira-mcp.json, accepting the .mcp.json stdio shape and expanding ${VAR}", () => {
    writeFileSync(
      file,
      JSON.stringify({
        serverName: "jira",
        server: { command: "npx", args: ["-y", "mcp-atlassian"], env: { JIRA_API_TOKEN: "${MY_TOKEN}" } },
        tools: { getIssue: "jira_get_issue", addComment: "jira_add_comment", searchIssues: null, readOnlyExtras: [] },
      }),
    );
    const cfg = loadJiraMcpConfig({ MY_TOKEN: "secret", PATH: "/bin" })!;
    expect(cfg.serverName).toBe("jira");
    expect(cfg.server).toMatchObject({ type: "stdio", command: "npx", args: ["-y", "mcp-atlassian"] });
    expect(cfg.server.type === "stdio" && cfg.server.env).toMatchObject({ JIRA_API_TOKEN: "secret", PATH: "/bin" });
    expect(cfg.tools.searchIssues).toBeNull();
    expect(jiraToolsFor(cfg, "read")).toEqual(["mcp__jira__jira_get_issue"]);
    expect(mcpServersOption(cfg)).toHaveProperty("jira");
  });

  it("builds an http server from env vars and uses default Atlassian tool names", () => {
    const cfg = loadJiraMcpConfig({
      JIRA_MCP_URL: "https://mcp.example.com/v1/mcp?token=${T}",
      JIRA_MCP_HEADERS: '{"Authorization":"Bearer ${T}"}',
      T: "abc",
    })!;
    expect(cfg.serverName).toBe("atlassian-local");
    expect(cfg.server).toEqual({
      type: "http",
      url: "https://mcp.example.com/v1/mcp?token=abc",
      headers: { Authorization: "Bearer abc" },
    });
    expect(cfg.tools).toEqual(DEFAULT_JIRA_TOOLS);
  });

  it("lets env override file fields", () => {
    writeFileSync(file, JSON.stringify({ serverName: "a", server: { type: "sse", url: "https://x/sse" } }));
    const cfg = loadJiraMcpConfig({ JIRA_MCP_SERVER_NAME: "b", JIRA_MCP_TOOL_GET_ISSUE: "get_issue" })!;
    expect(cfg.serverName).toBe("b");
    expect(cfg.server.type).toBe("sse");
    expect(cfg.tools.getIssue).toBe("get_issue");
    expect(cfg.source).toContain("file:");
  });

  it("rejects invalid config with a clear error", () => {
    writeFileSync(file, "{not json");
    expect(() => loadJiraMcpConfig({})).toThrow(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ server: { type: "http" } }));
    expect(() => loadJiraMcpConfig({})).toThrow(/invalid JIRA MCP server config/);
    expect(() => loadJiraMcpConfig({ JIRA_MCP_CONFIG: "missing.json" })).toThrow(/does not exist/);
    expect(() => loadJiraMcpConfig({ JIRA_MCP_COMMAND: "x", JIRA_MCP_ARGS: "-y foo" })).toThrow(/must be JSON/);
    expect(() => loadJiraMcpConfig({ JIRA_MCP_COMMAND: "x", JIRA_MCP_SERVER_NAME: "bad name" })).toThrow(/may only contain/);
  });
});

describe("jiraToolsFor", () => {
  it("never hands out the add-comment tool, and limits `issue` access to fetching one issue", () => {
    const cfg = loadJiraMcpConfig({ JIRA_MCP_URL: "https://x", JIRA_MCP_TOOLS_READ_EXTRA: "addCommentToJiraIssue, atlassianUserInfo" })!;
    expect(jiraToolsFor(cfg, "issue")).toEqual(["mcp__atlassian-local__getJiraIssue"]);
    const read = jiraToolsFor(cfg, "read");
    expect(read).toContain("mcp__atlassian-local__searchJiraIssuesUsingJql");
    expect(read).toContain("mcp__atlassian-local__atlassianUserInfo");
    expect(read).not.toContain("mcp__atlassian-local__addCommentToJiraIssue");
  });
});

describe("describeJiraMcp", () => {
  it("never exposes secrets", () => {
    const prev = { ...process.env };
    process.env.JIRA_MCP_URL = "https://mcp.example.com/v1/mcp?token=supersecret";
    process.env.JIRA_MCP_HEADERS = '{"Authorization":"Bearer supersecret"}';
    try {
      const d = describeJiraMcp();
      expect(d.configured).toBe(true);
      expect(d.target).toBe("https://mcp.example.com/v1/mcp");
      expect(JSON.stringify(d)).not.toContain("supersecret");
    } finally {
      process.env = prev;
    }
  });
});

describe("expandEnvRefs", () => {
  it("replaces unset variables with empty strings", () => {
    expect(expandEnvRefs("a${X}b${Y}", { X: "1" })).toBe("a1b");
  });
});
