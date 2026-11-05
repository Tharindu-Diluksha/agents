import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { log } from "./log.js";

/*
 * Request guard for a server that is meant to be reached only from this
 * machine's browser.
 *
 * - Host allowlist (blocks DNS rebinding: a hostile page whose domain resolves
 *   to 127.0.0.1 sends `Host: evil.example`).
 * - Origin allowlist for WebSocket upgrades and every state-changing request
 *   (blocks other websites from reading the event stream — browsers let any
 *   page open a WebSocket to localhost — and from cross-site form posts).
 *   Requests without an Origin header (curl, scripts) are allowed: a web page
 *   cannot send a cross-origin POST or WebSocket upgrade without one.
 */

const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

export function allowedHostnames(extra: string[] = []): Set<string> {
  return new Set([...LOCAL_HOSTNAMES, ...extra].map((h) => h.trim().toLowerCase()).filter(Boolean));
}

/** Hostname part of a Host header (`127.0.0.1:5174`, `[::1]:5174`, `localhost`). */
export function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(0, end + 1) : null;
  }
  return h.split(":")[0] || null;
}

export function isAllowedHost(hostHeader: string | undefined, allowed: Set<string>): boolean {
  const name = hostnameOf(hostHeader);
  return name !== null && allowed.has(name);
}

export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>): boolean {
  if (origin === undefined) return true; // non-browser client
  if (origin === "null") return false; // sandboxed iframes, file:// pages
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return allowed.has(u.hostname.toLowerCase()) || allowed.has(`[${u.hostname.toLowerCase()}]`);
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Register after @fastify/websocket so its own upgrade bookkeeping runs first. */
export function registerRequestGuard(app: FastifyInstance, extraHosts: string[] = []): void {
  const allowed = allowedHostnames(extraHosts);
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const isUpgrade = (req.headers.upgrade ?? "").toLowerCase() === "websocket";
    if (!isAllowedHost(req.headers.host, allowed)) {
      log.warn("security.host_rejected", { host: req.headers.host, url: req.url });
      if (isUpgrade) reply.raw.once("finish", () => req.raw.socket?.destroy());
      return reply.code(403).send({ error: "forbidden_host" });
    }
    if (isUpgrade || !SAFE_METHODS.has(req.method)) {
      const origin = req.headers.origin;
      if (!isAllowedOrigin(origin, allowed)) {
        log.warn("security.origin_rejected", { origin, method: req.method, url: req.url });
        // A refused upgrade never reaches the websocket plugin's cleanup, so
        // close the raw socket ourselves once the 403 has been written.
        if (isUpgrade) reply.raw.once("finish", () => req.raw.socket?.destroy());
        return reply.code(403).send({ error: "forbidden_origin" });
      }
    }
  });
}
