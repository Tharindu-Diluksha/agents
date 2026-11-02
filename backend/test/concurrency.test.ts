import { describe, expect, it } from "vitest";
import { Semaphore } from "../src/orchestrator/concurrency.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("Semaphore", () => {
  it("grants up to the limit and queues the rest in order", async () => {
    const sem = new Semaphore(() => 2);
    const order: string[] = [];
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const positions: number[] = [];
    const p3 = sem.acquire(undefined, (p) => positions.push(p)).then((r) => (order.push("3"), r));
    const p4 = sem.acquire(undefined, (p) => positions.push(p)).then((r) => (order.push("4"), r));
    await tick();
    expect(sem.running).toBe(2);
    expect(sem.queued).toBe(2);
    expect(positions).toEqual([1, 2]);

    r1();
    const r3 = await p3;
    expect(order).toEqual(["3"]);
    r2();
    r2(); // double release is a no-op
    const r4 = await p4;
    expect(order).toEqual(["3", "4"]);
    expect(sem.running).toBe(2);
    r3();
    r4();
    expect(sem.running).toBe(0);
  });

  it("treats a limit of 0 as unlimited and reads the limit live", async () => {
    let limit = 0;
    const sem = new Semaphore(() => limit);
    const rs = await Promise.all([sem.acquire(), sem.acquire(), sem.acquire()]);
    expect(sem.running).toBe(3);
    limit = 1;
    const waiting = sem.acquire();
    await tick();
    expect(sem.queued).toBe(1);
    rs.forEach((r) => r()); // drops to 0, then the waiter gets the single slot
    await waiting;
    expect(sem.running).toBe(1);
  });

  it("removes an aborted waiter from the queue", async () => {
    const sem = new Semaphore(() => 1);
    const r1 = await sem.acquire();
    const ctrl = new AbortController();
    const p = sem.acquire(ctrl.signal);
    await tick();
    ctrl.abort();
    await expect(p).rejects.toThrow("aborted");
    expect(sem.queued).toBe(0);
    r1();
    expect(sem.running).toBe(0);
  });
});
