import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";

/**
 * Single-instance lock on the state folder. Run state is cached in memory
 * (runStore.ts), so two backends sharing `runs/` would overwrite each other.
 *
 * The lock file holds `{ pid, host, port, startedAt, heartbeatAt }`:
 * - same host: the holder is alive while its pid is (stale locks from a
 *   crashed process are taken over);
 * - another host (e.g. another container sharing the volume, where pids say
 *   nothing — every container's backend tends to be pid 1): the holder is
 *   alive while its heartbeat is recent. The holder refreshes it every
 *   HEARTBEAT_MS; a lock not refreshed for STALE_MS is taken over.
 */
export interface LockInfo {
  pid: number;
  host?: string;
  port?: number;
  startedAt: string;
  heartbeatAt?: string;
}

export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

export class InstanceLockError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(
      `another orchestrator backend (${holder.host ? `host ${holder.host}, ` : ""}pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}, started ${holder.startedAt}) is using this state folder. Stop it first, or point this one at a different folder.`,
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

/** Whether `holder` is a live backend other than us. */
export function holderIsLive(holder: LockInfo, me: { pid: number; host: string }, now = Date.now()): boolean {
  const sameHost = (holder.host ?? me.host) === me.host; // locks from before `host` existed were same-host
  if (sameHost) return holder.pid !== me.pid && isProcessAlive(holder.pid);
  const beat = Date.parse(holder.heartbeatAt ?? holder.startedAt);
  return Number.isFinite(beat) && now - beat < STALE_MS;
}

/**
 * Takes the lock or throws InstanceLockError. Waits up to `waitMs` for a live
 * holder to exit first (a `tsx watch` restart can briefly overlap the old
 * process). Returns a release function; while held, the heartbeat is refreshed.
 */
export async function acquireInstanceLock(
  file: string,
  info: { port?: number },
  opts: { waitMs?: number; pid?: number; host?: string; heartbeatMs?: number } = {},
): Promise<() => void> {
  const me = { pid: opts.pid ?? process.pid, host: opts.host ?? osHostname() };
  const deadline = Date.now() + (opts.waitMs ?? 3000);
  mkdirSync(dirname(file), { recursive: true });
  const startedAt = new Date().toISOString();
  const body = () => JSON.stringify({ pid: me.pid, host: me.host, port: info.port, startedAt, heartbeatAt: new Date().toISOString() } satisfies LockInfo);

  for (;;) {
    try {
      writeFileSync(file, body(), { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readLock(file);
      if (holder && holderIsLive(holder, me)) {
        if (Date.now() >= deadline) throw new InstanceLockError(holder);
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      // Stale (dead pid, old heartbeat, unreadable, or our own leftover): take it over.
      rmSync(file, { force: true });
    }
  }

  const ours = () => {
    const l = readLock(file);
    return l?.pid === me.pid && (l.host ?? me.host) === me.host && l.startedAt === startedAt;
  };
  const timer = setInterval(() => {
    try {
      if (ours()) writeFileSync(file, body());
    } catch {
      /* the next beat retries */
    }
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();

  let released = false;
  return () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    if (ours()) rmSync(file, { force: true });
  };
}
