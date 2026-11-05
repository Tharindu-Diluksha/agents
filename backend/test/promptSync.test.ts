import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  APP_ROLES_DIR,
  blockNames,
  drifted,
  fillBlocks,
  loadFragments,
  PLUGIN_AGENTS_DIR,
} from "../scripts/promptSync.js";
import { STACK_IDS, STACKS, stackBashPatterns } from "../src/stacks.js";
import { checkBashCommand } from "../src/sdk/permissions.js";

const md = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md"));
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const body = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, ""); // drop frontmatter

describe("shared prompt blocks", () => {
  it("everything generated is up to date (run `npm run sync:prompts`)", () => {
    expect(drifted()).toEqual([]);
  });

  it("every shared fragment is used by both the app and the plugin", () => {
    const usedBy = (dir: string) => new Set(md(dir).flatMap((f) => blockNames(read(dir, f))));
    const app = usedBy(APP_ROLES_DIR);
    const plugin = usedBy(PLUGIN_AGENTS_DIR);
    for (const name of loadFragments().keys()) {
      expect(app.has(name), `${name} in roles/`).toBe(true);
      expect(plugin.has(name), `${name} in plugin agents`).toBe(true);
    }
  });

  it("rejects an unknown block name", () => {
    expect(() => fillBlocks("<!-- shared:nope -->\n<!-- /shared:nope -->", new Map(), "x.md")).toThrow(/unknown shared block "nope"/);
  });

  it("app roles keep the orchestrator's terminal JSON contract", () => {
    for (const f of md(APP_ROLES_DIR)) {
      const text = read(APP_ROLES_DIR, f);
      expect(text, f).toContain("## Terminal JSON block (mandatory)");
      expect(text, f).toMatch(/```json\n\{[\s\S]*"status"/);
    }
  });

  it("role prompts and fragments are stack-neutral (stack specifics come from stacks.ts)", () => {
    const stackWords = /\b(npm|npx|pnpm|yarn|vitest|jest|pytest|dotnet|go test|playwright\.config)\b/i;
    const files = [
      ...md(APP_ROLES_DIR).map((f) => [f, read(APP_ROLES_DIR, f)] as const),
      ...md(PLUGIN_AGENTS_DIR).map((f) => [`plugin/${f}`, body(read(PLUGIN_AGENTS_DIR, f))] as const),
      ...[...loadFragments()].map(([n, t]) => [`shared/${n}`, t] as const),
    ];
    for (const [name, text] of files) expect(text, name).not.toMatch(stackWords);
  });
});

describe("stack example commands", () => {
  it("every example a role is shown is actually allowed for that stack", () => {
    for (const id of STACK_IDS) {
      for (const [cap, cmds] of Object.entries(STACKS[id].examples)) {
        const allow = stackBashPatterns([id], [cap as never]);
        for (const cmd of cmds ?? []) {
          const concrete = cmd.replace(/<[^>]+>/g, "x").replace(/"[^"]*"/g, '"x"');
          expect(checkBashCommand(concrete, allow, []).allow, `${id} ${cap}: ${cmd}`).toBe(true);
        }
      }
    }
  });
});
