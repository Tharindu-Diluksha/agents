import { describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

const { classifyError, normalizeRoleOutput, parseTerminalJsonBlock, RoleOutputRawSchema } = await import("../src/sdk/runRole.js");

describe("parseTerminalJsonBlock", () => {
  it("takes the last fenced block with a status", () => {
    const text = [
      "```json\n{\"status\":\"blocked\"}\n```",
      "some prose",
      "```json\n{\"status\":\"done\",\"artifacts\":[]}\n```",
    ].join("\n");
    const r = parseTerminalJsonBlock(text);
    expect(r).toEqual({ ok: true, value: { status: "done", artifacts: [] } });
  });
  it("skips trailing fenced blocks that are not the contract", () => {
    const text = "```json\n{\"status\":\"done\"}\n```\n```ts\nconst x = 1;\n```";
    expect(parseTerminalJsonBlock(text)).toEqual({ ok: true, value: { status: "done" } });
  });
  it("fails on no text or no block", () => {
    expect(parseTerminalJsonBlock("").ok).toBe(false);
    expect(parseTerminalJsonBlock("all done!").ok).toBe(false);
  });
});

describe("normalizeRoleOutput", () => {
  it("maps legacy payloadPath and the legacy tester role", () => {
    const raw = RoleOutputRawSchema.parse({
      status: "blocked",
      approvalRequest: { action: "proceed_to_next", summary: "s", payloadPath: "a.md" },
      handoff: { nextRole: "tester" },
    });
    const out = normalizeRoleOutput(raw);
    expect(out.approvalRequest?.payloadPaths).toEqual(["a.md"]);
    expect(out.handoff?.nextRole).toBe("e2eTester");
    expect(out.artifacts).toEqual([]);
  });
  it("accepts the new tester roles", () => {
    for (const nextRole of ["unitTester", "integrationTester", "e2eTester"]) {
      expect(RoleOutputRawSchema.safeParse({ status: "blocked", approvalRequest: null, handoff: { nextRole } }).success).toBe(true);
    }
  });
});

describe("classifyError", () => {
  it.each([
    ["aborted", false],
    ["401 Unauthorized", false],
    ["400 bad request", false],
    ["ECONNRESET", true],
    ["529 overloaded", true],
    ["request timed out", true],
    ["TypeError: x is undefined", false],
  ])("%s → transient=%s", (msg, transient) => {
    expect(classifyError(new Error(msg)).transient).toBe(transient);
  });
});
