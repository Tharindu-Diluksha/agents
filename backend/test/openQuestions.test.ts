import { describe, expect, it } from "vitest";
import { countOpenQuestions, openQuestionItems } from "../src/orchestrator/openQuestions.js";

const doc = (section: string) => `# F\n\n## Open questions\n\n${section}\n\n## Non-goals\n\n- not counted\n`;

describe("openQuestionItems", () => {
  it("returns top-level numbered or bulleted items, without sub-bullets", () => {
    expect(openQuestionItems(doc("1. Who exports? (PM)\n   - context\n2. **CSV** or XLSX?\n- Retention?"))).toEqual([
      "Who exports? (PM)",
      "**CSV** or XLSX?",
      "Retention?",
    ]);
  });

  it("ignores placeholders, None, resolved items and a section that opens with None", () => {
    expect(countOpenQuestions(doc("- {{bullet}}"))).toBe(0);
    expect(countOpenQuestions(doc("None."))).toBe(0);
    expect(countOpenQuestions(doc("None. Closed:\n1. Was X?"))).toBe(0);
    expect(countOpenQuestions(doc("1. [x] done\n2. ~~gone~~\n3. Still open?"))).toBe(1);
    expect(countOpenQuestions("# F\n\nno section")).toBe(0);
  });
});
