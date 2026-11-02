import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "events-test-"));
});
vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  return { ...orig, paths: { ...orig.paths, runsDir: tmp } };
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const usage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe("event log", () => {
  it("persists events with a per-run sequence, skips live usage ticks, and truncates big tool inputs", async () => {
    const { emit, readEventLog, subscribeAll } = await import("../src/events.js");
    mkdirSync(join(tmp, "R1"));
    const live: Array<{ seq?: number; at: string; type: string }> = [];
    const off = subscribeAll((e) => live.push(e));

    emit({ type: "role.started", runId: "R1", role: "developer", attempt: 1 });
    emit({ type: "role.usage", runId: "R1", role: "developer", usage, costUsd: 0, final: false });
    emit({ type: "role.tool_call", runId: "R1", role: "developer", name: "Write", input: { content: "x".repeat(10_000) }, toolUseId: "t" });
    emit({ type: "role.usage", runId: "R1", role: "developer", usage, costUsd: 0.1, final: true });
    emit({ type: "role.started", runId: "NOPE", role: "developer", attempt: 1 }); // no run folder: not logged
    off();

    expect(live.map((e) => e.seq)).toEqual([1, undefined, 2, 3, undefined]);
    expect(live.every((e) => typeof e.at === "string")).toBe(true);
    const log = readEventLog("R1");
    expect(log.map((e) => [e.seq, e.type])).toEqual([
      [1, "role.started"],
      [2, "role.tool_call"],
      [3, "role.usage"],
    ]);
    expect((log[1] as { input: { truncated?: boolean } }).input.truncated).toBe(true);
    // Live subscribers still get the full input.
    expect(JSON.stringify((live[2] as unknown as { input: unknown }).input).length).toBeGreaterThan(10_000);
    expect(readEventLog("R1", 1).map((e) => e.seq)).toEqual([3]);
  });

  it("continues the sequence from disk after a restart and ignores a torn last line", async () => {
    vi.resetModules();
    const { emit, readEventLog } = await import("../src/events.js");
    emit({ type: "run.failed", runId: "R1", error: "x" });
    expect(readEventLog("R1").map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const file = join(tmp, "R1", "events.jsonl");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, '{"type":"run.fail');
    expect(readEventLog("R1")).toHaveLength(4);
    expect(readFileSync(file, "utf8").split("\n").filter(Boolean)).toHaveLength(5);
  });
});
