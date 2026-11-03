// Copies templates/*.md into the jira-to-pr plugin, so the skill and the
// orchestrator app fill in the same artifact shapes (needed for a fair
// side-by-side comparison). Run: npm run sync:plugin-templates
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "templates");
const to = join(root, "plugins", "jira-to-pr", "skills", "run", "templates");
for (const f of readdirSync(from).filter((f) => f.endsWith(".md"))) {
  copyFileSync(join(from, f), join(to, f));
  console.log(`synced ${f}`);
}
