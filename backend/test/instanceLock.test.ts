import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, holderIsLive, InstanceLockError, isProcessAlive, STALE_MS } from "../src/orchestrator/instanceLock.js";

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

describe("locks across containers", () => {
  it("two containers whose backends are both pid 1 don't take each other's lock", async () => {
    const file = join(dir, "e.lock");
    const releaseA = await acquireInstanceLock(file, {}, { pid: 1, host: "container-a", heartbeatMs: 50 });
    await expect(acquireInstanceLock(file, {}, { pid: 1, host: "container-b", waitMs: 200 })).rejects.toThrow(/host container-a/);
    releaseA();
    const releaseB = await acquireInstanceLock(file, {}, { pid: 1, host: "container-b" });
    expect(JSON.parse(readFileSync(file, "utf8")).host).toBe("container-b");
    releaseB();
  });

  it("keeps a held lock's heartbeat fresh, and takes over one from a host that stopped beating", async () => {
    const file = join(dir, "f.lock");
    const release = await acquireInstanceLock(file, {}, { host: "me", heartbeatMs: 20 });
    const first = JSON.parse(readFileSync(file, "utf8")).heartbeatAt;
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.parse(readFileSync(file, "utf8")).heartbeatAt > first).toBe(true);
    release();

    const old = new Date(Date.now() - STALE_MS - 1000).toISOString();
    writeFileSync(file, JSON.stringify({ pid: 1, host: "dead-container", startedAt: old, heartbeatAt: old }));
    const takeover = await acquireInstanceLock(file, {}, { pid: 1, host: "new-container" });
    expect(JSON.parse(readFileSync(file, "utf8")).host).toBe("new-container");
    takeover();
  });

  it("judges liveness by pid on the same host and by heartbeat across hosts", () => {
    const now = Date.now();
    const me = { pid: 999999, host: "h1" };
    expect(holderIsLive({ pid: process.pid, host: "h1", startedAt: "" }, me)).toBe(true);
    expect(holderIsLive({ pid: 2 ** 22 + 7, host: "h1", startedAt: "" }, me)).toBe(false);
    expect(holderIsLive({ pid: 1, host: "h2", startedAt: "", heartbeatAt: new Date(now - 5_000).toISOString() }, me, now)).toBe(true);
    expect(holderIsLive({ pid: 1, host: "h2", startedAt: "", heartbeatAt: new Date(now - STALE_MS - 1).toISOString() }, me, now)).toBe(false);
  });
});

describe("isProcessAlive", () => {
  it("detects live and invalid pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
  });
});
