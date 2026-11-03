/**
 * FIFO limiter for role sessions across all runs. `limit()` is read on every
 * acquire/release, so a config change applies without rebuilding the queue.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ grant: () => void; signal?: AbortSignal; onAbort?: () => void }> = [];

  constructor(private readonly limit: () => number) {}

  get running(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private hasCapacity(): boolean {
    const max = this.limit();
    return max <= 0 || this.active < max;
  }

  /** Grants a slot immediately if one is free and nobody is waiting; returns its release function, or null. */
  tryAcquire(): (() => void) | null {
    if (this.waiters.length > 0 || !this.hasCapacity()) return null;
    this.active++;
    return this.releaser();
  }

  /**
   * Waits for a slot. Rejects with Error("aborted") if `signal` aborts while
   * waiting. `onQueued` receives the 1-based queue position when it has to wait.
   */
  acquire(signal?: AbortSignal, onQueued?: (position: number) => void): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    if (signal?.aborted) return Promise.reject(new Error("aborted"));
    return new Promise((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        signal,
        grant: () => {
          if (waiter.onAbort) signal?.removeEventListener("abort", waiter.onAbort);
          this.active++;
          resolve(this.releaser());
        },
      };
      if (signal) {
        waiter.onAbort = () => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
      onQueued?.(this.waiters.length);
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && this.hasCapacity()) {
      this.waiters.shift()!.grant();
    }
  }
}
