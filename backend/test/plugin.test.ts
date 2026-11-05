import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * Structural checks for the jira-to-pr Claude Code plugin (plugins/jira-to-pr).
 * The plugin is prompts, not code, so this guards against drift: templates
 * must match the orchestrator's, and the skill must reference every agent.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const plugin = join(root, "plugins", "jira-to-pr");
const read = (p: string) => readFileSync(p, "utf8");

function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  return Object.fromEntries(
    m[1]!
      .split("\n")
      .map((l) => l.match(/^([A-Za-z-]+):\s*(.*)$/))
      .filter((x): x is RegExpMatchArray => Boolean(x))
      .map((x) => [x[1]!, x[2]!.trim()]),
  );
}

const agents = readdirSync(join(plugin, "agents")).filter((f) => f.endsWith(".md"));
const skill = read(join(plugin, "skills", "run", "SKILL.md"));

describe("jira-to-pr plugin", () => {
  it("has a manifest and is listed in the repo marketplace", () => {
    const manifest = JSON.parse(read(join(plugin, ".claude-plugin", "plugin.json")));
    expect(manifest.name).toBe("jira-to-pr");
    const market = JSON.parse(read(join(root, ".claude-plugin", "marketplace.json")));
    expect(market.plugins).toContainEqual(expect.objectContaining({ name: "jira-to-pr", source: "./plugins/jira-to-pr" }));
  });

  it("ships the same artifact templates as the orchestrator app (run `npm run sync:plugin-templates`)", () => {
    const appTemplates = readdirSync(join(root, "templates")).filter((f) => f.endsWith(".md")).sort();
    const pluginTemplates = readdirSync(join(plugin, "skills", "run", "templates")).sort();
    expect(pluginTemplates).toEqual(appTemplates);
    for (const f of appTemplates) {
      expect(read(join(plugin, "skills", "run", "templates", f)), f).toBe(read(join(root, "templates", f)));
    }
  });

  it("defines each role agent with a name, description and tool list, and the skill calls every one", () => {
    expect(agents.sort()).toEqual(
      ["analyst", "developer", "e2e-tester", "integration-tester", "pr-writer", "reviewer", "unit-tester"].map((n) => `${n}.md`),
    );
    for (const f of agents) {
      const text = read(join(plugin, "agents", f));
      const fm = frontmatter(text);
      expect(fm.name, f).toBe(f.replace(/\.md$/, ""));
      expect(fm.description?.length ?? 0, f).toBeGreaterThan(20);
      expect(fm.tools, f).toBeTruthy();
      // Every agent ends with the Result block the skill parses.
      expect(text, f).toContain("## Result");
      expect(text, f).toMatch(/status:/);
      expect(skill, f).toContain(`jira-to-pr:${fm.name}`);
    }
  });

  it("keeps roles inside their bounds", () => {
    const tools = (name: string) => frontmatter(read(join(plugin, "agents", `${name}.md`))).tools!.split(/,\s*/);
    // Read-only roles can't edit source (they only Write their own report).
    for (const name of ["reviewer", "pr-writer"]) expect(tools(name)).not.toContain("Edit");
    expect(tools("analyst")).not.toContain("Bash");
    // No role gets JIRA/MCP or other agents' tools; the orchestrating session keeps those.
    for (const f of agents) expect(read(join(plugin, "agents", f))).not.toMatch(/^tools:.*mcp__/m);
  });

  it("is only run explicitly and resolves templates from its own folder", () => {
    const fm = frontmatter(skill);
    expect(fm.name).toBe("run");
    expect(fm["disable-model-invocation"]).toBe("true");
    expect(skill).toContain("${CLAUDE_SKILL_DIR}/templates/");
    expect(existsSync(join(plugin, "skills", "run", "reference", "ledger.md"))).toBe(true);
  });
});
