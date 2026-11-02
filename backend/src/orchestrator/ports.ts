import { createServer } from "node:net";
import { config } from "../config.js";
import type { PortBlock, RunRecord } from "./types.js";

/*
 * Port blocks for parallel runs. A run reserves one block while it has
 * worktrees; role sessions get it as env vars (see `runEnv`), and the role
 * prompts tell them to start every server on those ports.
 */

/** True if nothing on this machine is listening on 127.0.0.1:port right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

/**
 * Picks the lowest block not held by another run and not currently bound by
 * any process. `others` are the other runs to avoid (callers pass active runs).
 */
export async function allocatePortBlock(
  others: RunRecord[],
  opts: { rangeStart: number; rangeEnd: number; blockSize: number } = config.ports,
  free: (port: number) => Promise<boolean> = isPortFree,
): Promise<PortBlock> {
  const taken = others.map((r) => r.ports).filter((p): p is PortBlock => Boolean(p));
  const overlapsTaken = (base: number) =>
    taken.some((t) => base < t.base + t.count && t.base < base + opts.blockSize);

  for (let base = opts.rangeStart; base + opts.blockSize <= opts.rangeEnd; base += opts.blockSize) {
    if (overlapsTaken(base)) continue;
    let allFree = true;
    for (let p = base; p < base + opts.blockSize && allFree; p++) allFree = await free(p);
    if (allFree) return { base, count: opts.blockSize };
  }
  throw new Error(
    `no free block of ${opts.blockSize} ports in ${opts.rangeStart}-${opts.rangeEnd}; widen PORT_RANGE_START/PORT_RANGE_END or remove finished runs' worktrees`,
  );
}

/** Environment for a run's role sessions (inherited by every Bash command they run). */
export function runEnv(record: RunRecord): Record<string, string> {
  const env: Record<string, string> = { ORCH_RUN_ID: record.runId };
  const ports = record.ports;
  if (ports) {
    env.ORCH_PORT_BASE = String(ports.base);
    env.ORCH_PORT_COUNT = String(ports.count);
    env.ORCH_PORT_LAST = String(ports.base + ports.count - 1);
    // Conventional names many dev servers and Playwright configs already read.
    env.PORT = String(ports.base);
    env.E2E_PORT = String(ports.base);
    env.E2E_BASE_URL = `http://localhost:${ports.base}`;
    env.PLAYWRIGHT_BASE_URL = `http://localhost:${ports.base}`;
  }
  return env;
}

/** Prompt lines describing the run's ports, or [] when none are reserved. */
export function portsPromptLines(record: RunRecord): string[] {
  const p = record.ports;
  if (!p) return [];
  return [
    "",
    `**Ports reserved for this run: ${p.base}–${p.base + p.count - 1}.** Other runs may be running servers in parallel, so never use a framework's default port.`,
    `Your shell already has \`PORT=${p.base}\`, \`E2E_PORT=${p.base}\`, \`E2E_BASE_URL=http://localhost:${p.base}\`, \`ORCH_PORT_BASE=${p.base}\` and \`ORCH_PORT_COUNT=${p.count}\`. Start any dev server, test server or test database on a port in that range (use \`ORCH_PORT_BASE + n\` for extra services).`,
  ];
}
