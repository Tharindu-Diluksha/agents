import { describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { allocatePortBlock, isPortFree, runEnv } from "../src/orchestrator/ports.js";
import type { RunRecord } from "../src/orchestrator/types.js";

const run = (ports: RunRecord["ports"]) => ({ runId: "x", ports }) as unknown as RunRecord;
const opts = { rangeStart: 1000, rangeEnd: 1040, blockSize: 10 };
const allFree = async () => true;

describe("allocatePortBlock", () => {
  it("takes the lowest block not held by another run", async () => {
    expect(await allocatePortBlock([], opts, allFree)).toEqual({ base: 1000, count: 10 });
    expect(await allocatePortBlock([run({ base: 1000, count: 10 })], opts, allFree)).toEqual({ base: 1010, count: 10 });
    // A held block with a different size still blocks every block it touches.
    expect(await allocatePortBlock([run({ base: 1005, count: 10 })], opts, allFree)).toEqual({ base: 1020, count: 10 });
  });

  it("skips blocks where some other process is already listening", async () => {
    const busy = new Set([1003]);
    expect(await allocatePortBlock([], opts, async (p) => !busy.has(p))).toEqual({ base: 1010, count: 10 });
  });

  it("fails clearly when the range is exhausted", async () => {
    const held = [0, 1, 2, 3].map((i) => run({ base: 1000 + i * 10, count: 10 }));
    await expect(allocatePortBlock(held, opts, allFree)).rejects.toThrow(/no free block of 10 ports/);
  });
});

describe("isPortFree", () => {
  it("detects a port in use", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen({ port: 0, host: "127.0.0.1" }, () => r()));
    const port = (srv.address() as { port: number }).port;
    expect(await isPortFree(port)).toBe(false);
    await new Promise((r) => srv.close(r));
    expect(await isPortFree(port)).toBe(true);
  });
});

describe("runEnv", () => {
  it("exposes the block under conventional names", () => {
    const env = runEnv({ runId: "R1", repos: [], ports: { base: 41010, count: 10 } } as unknown as RunRecord);
    expect(env).toEqual({
      ORCH_RUN_ID: "R1",
      ORCH_PORT_BASE: "41010",
      ORCH_PORT_COUNT: "10",
      ORCH_PORT_LAST: "41019",
      PORT: "41010",
      E2E_PORT: "41010",
      E2E_BASE_URL: "http://localhost:41010",
      PLAYWRIGHT_BASE_URL: "http://localhost:41010",
    });
    expect(runEnv({ runId: "R2", repos: [] } as unknown as RunRecord)).toEqual({ ORCH_RUN_ID: "R2" });
  });
});
