import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, InstanceLockError, isProcessAlive } from "../src/orchestrator/instanceLock.js";

const dir = mkdtempSync(join(tmpdir(), "lock-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("acquireInstanceLock", () => {
  it("creates and releases the lock", async () => {
    const file = join(dir, "a.lock");
    const release = await acquireInstanceLock(file, { port: 5174 });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, port: 5174 });
    release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses while another live process holds it", async () => {
    const file = join(dir, "b.lock");
    // The test runner's parent process is alive and isn't us.
    writeFileSync(file, JSON.stringify({ pid: process.ppid, port: 1, startedAt: "x" }));
    await expect(acquireInstanceLock(file, {}, { waitMs: 300 })).rejects.toBeInstanceOf(InstanceLockError);
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.ppid);
  });

  it("takes over a stale lock from a dead process", async () => {
    const file = join(dir, "c.lock");
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, startedAt: "x" }));
    const release = await acquireInstanceLock(file, {});
    expect(JSON.parse(readFileSync(file, "utf8")).pid).toBe(process.pid);
    release();
  });

  it("does not delete a lock someone else took over", async () => {
    const file = join(dir, "d.lock");
    const release = await acquireInstanceLock(file, {});
    writeFileSync(file, JSON.stringify({ pid: process.ppid, startedAt: "x" }));
    release();
    expect(existsSync(file)).toBe(true);
  });
});

describe("isProcessAlive", () => {
  it("detects live and invalid pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
