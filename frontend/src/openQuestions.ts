const NONE = /^(none|n\/a|no open questions|nothing open)\b/i;
const plain = (s: string) => s.replace(/[*_`]/g, "").trim();

/**
 * Counts the top-level items under a markdown "## Open questions" heading
 * (numbered or bulleted). Sub-bullets (indented) belong to their parent item.
 *
 * Not counted: unfilled template placeholders, items that say "None", items
 * marked resolved (`[x]` or ~~struck through~~), and everything in a section
 * that opens with "None" — Analysts often write "None. Everything is closed:"
 * followed by a list of the questions they closed.
 */
export function countOpenQuestions(markdown: string): number {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s+open questions\b/i.test(l.trim()));
  if (start === -1) return 0;
  const level = /^(#+)/.exec(lines[start]!.trim())![1]!.length;

  let count = 0;
  let first = true;
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+)\s/.exec(line);
    if (heading && heading[1]!.length <= level) break;
    if (!line.trim()) continue;
    const item = /^(?:\d+[.)]|[-*+])\s+(.*)$/.exec(line);
    // The section's first line says there is nothing open: whatever follows is a record of closed ones.
    if (first && NONE.test(plain(item ? item[1]! : line))) return 0;
    first = false;
    if (!item) continue;
    const text = item[1]!.trim();
    if (!text || text.includes("{{") || NONE.test(plain(text))) continue;
    if (/^\[[xX]\]/.test(text) || /^~~/.test(text)) continue;
    count++;
  }
  return count;
}
