import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Single-instance lock on the state folder. Run state is cached in memory
 * (runStore.ts), so two backends sharing `runs/` would overwrite each other.
 *
 * The lock file holds `{ pid, port, startedAt }`. A lock whose pid is no
 * longer alive is stale and taken over.
 */
export interface LockInfo {
  pid: number;
  port?: number;
  startedAt: string;
}

export class InstanceLockError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `another orchestrator backend (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}, started ${holder.startedAt}) is using this state folder. Stop it first, or point this one at a different folder.`,
    );
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLock(file: string): LockInfo | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockInfo;
  } catch {
    return null;
  }
}

/**
 * Takes the lock or throws InstanceLockError. Waits up to `waitMs` for a live
 * holder to exit first (a `tsx watch` restart can briefly overlap the old process).
 * Returns a release function.
 */
export async function acquireInstanceLock(
  file: string,
  info: { port?: number },
  opts: { waitMs?: number; pid?: number } = {},
): Promise<() => void> {
  const pid = opts.pid ?? process.pid;
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  mkdirSync(dirname(file), { recursive: true });
  const body = JSON.stringify({ pid, port: info.port, startedAt: new Date().toISOString() } satisfies LockInfo);

  for (;;) {
    try {
      writeFileSync(file, body, { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(file);
      if (holder && holder.pid !== pid && isProcessAlive(holder.pid)) {
        if (Date.now() >= deadline) throw new InstanceLockError(holder);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      // Stale (dead pid, unreadable, or our own pid from a previous life): take it over.
      rmSync(file, { force: true });
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (readLock(file)?.pid === pid) rmSync(file, { force: true });
  };
}
