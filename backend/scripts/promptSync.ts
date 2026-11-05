/*
 * Generates the parts of the role prompts that are shared between the
 * orchestrator app (roles/*.md) and the jira-to-pr plugin
 * (plugins/jira-to-pr/agents/*.md), plus the plugin's copies of the artifact
 * templates and its stack guide.
 *
 *   npm run sync:prompts           write everything
 *   npm run sync:prompts -- --check  exit 1 if anything is out of date
 *
 * Shared blocks: a target file contains
 *   <!-- shared:NAME -->
 *   …generated from prompts/shared/NAME.md…
 *   <!-- /shared:NAME -->
 * Edit prompts/shared/NAME.md (never the block), then run the sync.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DETECTION_RULES, STACK_IDS, STACKS } from "../src/stacks.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SHARED_DIR = join(ROOT, "prompts", "shared");
export const APP_ROLES_DIR = join(ROOT, "roles");
export const PLUGIN_DIR = join(ROOT, "plugins", "jira-to-pr");
export const PLUGIN_AGENTS_DIR = join(PLUGIN_DIR, "agents");
export const PLUGIN_TEMPLATES_DIR = join(PLUGIN_DIR, "skills", "run", "templates");
export const PLUGIN_STACK_GUIDE = join(PLUGIN_DIR, "skills", "run", "reference", "stacks.md");
const TEMPLATES_DIR = join(ROOT, "templates");

const BLOCK = /<!-- shared:([a-z0-9-]+) -->[\s\S]*?<!-- \/shared:\1 -->/g;

export function loadFragments(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SHARED_DIR).filter((f) => f.endsWith(".md"))) {
    out.set(f.replace(/\.md$/, ""), readFileSync(join(SHARED_DIR, f), "utf8").trim());
  }
  return out;
}

/** Names of the shared blocks a text contains, in order. */
export function blockNames(text: string): string[] {
  return [...text.matchAll(BLOCK)].map((m) => m[1]!);
}

/** Fills every shared block in `text` from `fragments`. Throws on an unknown block name. */
export function fillBlocks(text: string, fragments: Map<string, string>, file = "<text>"): string {
  return text.replace(BLOCK, (_all, name: string) => {
    const body = fragments.get(name);
    if (body === undefined) throw new Error(`${file}: unknown shared block "${name}" (no prompts/shared/${name}.md)`);
    return `<!-- shared:${name} -->\n${body}\n<!-- /shared:${name} -->`;
  });
}

export function promptTargets(): string[] {
  const md = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
  return [...md(APP_ROLES_DIR), ...md(PLUGIN_AGENTS_DIR)];
}

/** The plugin's stack guide, generated from the same profiles the app uses. */
export function renderStackGuide(): string {
  const lines = [
    "# Stack guide",
    "",
    "<!-- Generated from backend/src/stacks.ts by `npm run sync:prompts`; do not edit by hand. -->",
    "",
    "The orchestrator detects each repo's stack and passes it to every subagent, which reads its section below.",
    "",
    "## Detecting the stack",
    "",
    ...DETECTION_RULES.map((r) => `- ${r}`),
    "",
    "A repo can have several stacks (e.g. `react` + `go`). Use every matching section.",
    "",
  ];
  for (const id of STACK_IDS) {
    const p = STACKS[id];
    const g = p.guidance;
    const cmd = (cap: keyof typeof p.examples) => (p.examples[cap] ?? []).map((c) => `\`${c}\``).join(", ") || "—";
    lines.push(
      `## ${p.label} (\`${id}\`)`,
      "",
      g.summary,
      "",
      `- **Unit tests:** ${g.unit}`,
      `- **Integration tests:** ${g.integration}`,
      `- **E2E:** ${g.e2e} An existing suite looks like ${g.e2eSuite}.`,
      `- **Review checks:** ${g.review}`,
      `- **Ports:** ${g.ports}`,
      "",
      "| Purpose | Commands |",
      "| ------- | -------- |",
      `| Test / typecheck | ${cmd("test")} |`,
      `| Lint | ${cmd("lint")} |`,
      `| Build | ${cmd("build")} |`,
      `| Dependency audit | ${cmd("audit")} |`,
      `| E2E | ${cmd("e2e")} |`,
      `| Install (E2E setup, after approval) | ${cmd("install")} |`,
      "",
    );
  }
  return lines.join("\n");
}

export interface Planned {
  path: string;
  content: string | Buffer;
}

/** Everything the sync would write, computed without touching disk. */
export function plan(): Planned[] {
  const fragments = loadFragments();
  const out: Planned[] = [];
  for (const file of promptTargets()) {
    const text = readFileSync(file, "utf8");
    out.push({ path: file, content: fillBlocks(text, fragments, relative(ROOT, file)) });
  }
  for (const f of readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md"))) {
    out.push({ path: join(PLUGIN_TEMPLATES_DIR, f), content: readFileSync(join(TEMPLATES_DIR, f)) });
  }
  out.push({ path: PLUGIN_STACK_GUIDE, content: renderStackGuide() });
  return out;
}

/** Paths whose on-disk content differs from what the sync would write. */
export function drifted(): string[] {
  return plan()
    .filter((p) => !existsSync(p.path) || !Buffer.from(readFileSync(p.path)).equals(Buffer.from(p.content)))
    .map((p) => relative(ROOT, p.path));
}

function main(): void {
  if (process.argv.includes("--check")) {
    const stale = drifted();
    if (stale.length > 0) {
      console.error(`Out of date (run \`npm run sync:prompts\`):\n${stale.map((s) => `  ${s}`).join("\n")}`);
      process.exit(1);
    }
    console.log("prompts, plugin templates and stack guide are in sync");
    return;
  }
  for (const p of plan()) {
    const before = existsSync(p.path) ? readFileSync(p.path) : null;
    if (before && Buffer.from(before).equals(Buffer.from(p.content))) continue;
    if (typeof p.content === "string") writeFileSync(p.path, p.content);
    else copyFileSync(join(TEMPLATES_DIR, p.path.split(/[\\/]/).pop()!), p.path);
    console.log(`updated ${relative(ROOT, p.path)}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
