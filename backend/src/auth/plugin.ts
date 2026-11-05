import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { log } from "../log.js";
import type { AuditLog } from "./audit.js";
import { allows, appRoles, requirementFor, type AppRole, type Requirement } from "./authz.js";
import { randomId, Sealer, sha256 } from "./crypto.js";
import type { OidcClient, Tokens } from "./oidc.js";
import type { Session, SessionStore } from "./sessions.js";

/*
 * Authentication + authorization for every request (HTTP and WebSocket).
 *
 * AUTH_MODE=none   everyone is the local admin; nothing to log in to.
 * AUTH_MODE=keycloak
 *   - /auth/login → Keycloak (code + PKCE); /auth/callback creates a session
 *     and sets an httpOnly cookie. The browser never sees a token.
 *   - Each request loads the session by the cookie's hash, enforces idle and
 *     absolute expiry, refreshes the access token when it has expired (so a
 *     user disabled or with changed roles in Keycloak is picked up within one
 *     token lifetime), then checks the route's required role.
 */

export interface AuthUser {
  sub: string;
  name: string;
  email: string | null;
  roles: AppRole[];
}

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    sessionHash: string | null;
  }
}

export const LOCAL_USER: AuthUser = { sub: "local", name: "local user", email: null, roles: ["admin"] };

export const SESSION_COOKIE = "orch_session";
const LOGIN_COOKIE = "orch_login";
const LOGIN_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 30_000;
const TOUCH_EVERY_MS = 60_000;

export interface AuthDeps {
  mode: "none" | "keycloak";
  sessions?: SessionStore;
  oidc?: OidcClient;
  audit: AuditLog;
  sessionSecret?: string;
  publicUrl: string;
  idleMinutes: number;
  maxHours: number;
}

export interface AuthHandle {
  /** Register a WebSocket so logout/expiry can close it. */
  trackSocket(sessionHash: string | null, socket: { close(code?: number, reason?: string): void }): () => void;
  /** Delete expired/idle sessions and close their sockets. */
  sweep(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Cookies (tiny, no dependency)
// ---------------------------------------------------------------------------

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, opts: { maxAgeSec: number; path?: string; secure: boolean }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
    "HttpOnly",
    "SameSite=Lax", // sent on the top-level redirect back from Keycloak; not on cross-site subrequests
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

/** Only same-site relative paths: never `//evil.example` or `https://…`. */
export function safeReturnTo(v: unknown): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
}

// ---------------------------------------------------------------------------

export function registerAuth(app: FastifyInstance, deps: AuthDeps): AuthHandle {
  const secure = deps.publicUrl.startsWith("https://");
  const idleMs = deps.idleMinutes * 60_000;
  const sealer = deps.mode === "keycloak" ? new Sealer(deps.sessionSecret ?? "", "session") : null;
  const sockets = new Map<string, Set<{ close(code?: number, reason?: string): void }>>();
  const refreshing = new Map<string, Promise<Session | null>>();

  app.decorateRequest("user", null);
  app.decorateRequest("sessionHash", null);

  const closeSockets = (hash: string, reason: string) => {
    for (const s of sockets.get(hash) ?? []) {
      try {
        s.close(4401, reason);
      } catch {
        /* already closed */
      }
    }
    sockets.delete(hash);
  };

  const toUser = (s: Session): AuthUser => ({ sub: s.userSub, name: s.userName, email: s.email, roles: appRoles(s.roles) });

  const sessionFields = (t: Tokens) => ({
    roles: t.roles,
    idToken: t.idToken,
    refreshToken: t.refreshToken ? sealer!.seal(t.refreshToken) : null,
    accessExpiresAt: new Date(Date.now() + t.expiresIn * 1000),
  });

  /** Valid session for this request (refreshed if needed), or null. Throws only if Keycloak is unreachable. */
  async function loadSession(req: FastifyRequest): Promise<Session | null> {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw || !deps.sessions) return null;
    const hash = sha256(raw);
    let s = await deps.sessions.get(hash);
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt.getTime() < now || s.lastSeenAt.getTime() < now - idleMs) {
      await deps.sessions.delete(hash);
      closeSockets(hash, "session expired");
      return null;
    }
    if (s.accessExpiresAt.getTime() - REFRESH_SKEW_MS < now) {
      // One refresh per session at a time, even with parallel requests.
      let p = refreshing.get(hash);
      if (!p) {
        p = refreshSession(s).finally(() => refreshing.delete(hash));
        refreshing.set(hash, p);
      }
      s = await p;
      if (!s) return null;
    } else if (now - s.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await deps.sessions.touch(hash);
    }
    return s;
  }

  async function refreshSession(s: Session): Promise<Session | null> {
    const rt = s.refreshToken ? sealer!.open(s.refreshToken) : null;
    if (!rt) {
      await deps.sessions!.delete(s.idHash);
      return null;
    }
    try {
      const t = await deps.oidc!.refresh(rt);
      if (t.sub !== s.userSub) throw new Error("subject changed on refresh");
      const update = { ...sessionFields(t), userName: t.name, email: t.email };
      await deps.sessions!.updateTokens(s.idHash, update);
      return { ...s, ...update, lastSeenAt: new Date() };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/cannot reach the identity provider|fetch failed|ECONNREFUSED|ETIMEDOUT/i.test(msg)) throw err;
      // invalid_grant etc.: the session was ended or the user disabled in Keycloak.
      log.info("auth.refresh_rejected", { sub: s.userSub, err: msg });
      await deps.sessions!.delete(s.idHash);
      closeSockets(s.idHash, "session ended");
      await deps.audit.record({ actor: { sub: s.userSub, name: s.userName }, action: "session_ended", details: { reason: msg } });
      return null;
    }
  }

  // ---- per-request check -------------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    const required: Requirement = requirementFor(req.method, req.routeOptions.url, req.url);
    const isUpgrade = (req.headers.upgrade ?? "").toLowerCase() === "websocket";

    if (deps.mode === "none") {
      req.user = LOCAL_USER;
      return;
    }

    let session: Session | null = null;
    try {
      session = await loadSession(req);
    } catch (err) {
      if (required === "public") return;
      return deny(reply, isUpgrade, 503, { error: "identity_provider_unavailable", detail: err instanceof Error ? err.message : String(err) });
    }
    if (session) {
      req.user = toUser(session);
      req.sessionHash = session.idHash;
    }
    if (required === "public") return;
    if (!req.user) return deny(reply, isUpgrade, 401, { error: "unauthenticated", login: "/auth/login" });
    if (!allows(req.user.roles, required)) {
      await deps.audit.record({
        actor: req.user,
        action: "access_denied",
        outcome: "denied",
        details: { method: req.method, route: req.routeOptions.url ?? req.url, required },
        ip: req.ip,
      });
      return deny(reply, isUpgrade, 403, { error: "forbidden", required });
    }
  });

  function deny(reply: FastifyReply, isUpgrade: boolean, code: number, body: Record<string, unknown>) {
    // A refused upgrade never reaches the websocket plugin's cleanup; close the socket ourselves.
    if (isUpgrade) reply.raw.once("finish", () => reply.request.raw.socket?.destroy());
    return reply.code(code).send(body);
  }

  // ---- routes ------------------------------------------------------------
  app.get("/auth/me", async (req, reply) => {
    if (!req.user) return reply.code(401).send({ authMode: deps.mode, error: "unauthenticated", login: "/auth/login" });
    return { authMode: deps.mode, user: req.user };
  });

  app.get<{ Querystring: { returnTo?: string } }>("/auth/login", async (req, reply) => {
    if (deps.mode === "none") return reply.redirect(safeReturnTo(req.query.returnTo));
    try {
      const start = await deps.oidc!.startLogin();
      const pending = sealer!.seal(
        JSON.stringify({ state: start.state, nonce: start.nonce, verifier: start.verifier, returnTo: safeReturnTo(req.query.returnTo), exp: Date.now() + LOGIN_TTL_MS }),
      );
      reply.header("set-cookie", cookie(LOGIN_COOKIE, pending, { maxAgeSec: LOGIN_TTL_MS / 1000, path: "/auth", secure }));
      return reply.redirect(start.url);
    } catch (err) {
      return reply.code(503).type("text/html").send(page("Sign-in unavailable", err instanceof Error ? err.message : String(err)));
    }
  });

  app.get("/auth/callback", async (req, reply) => {
    if (deps.mode === "none") return reply.redirect("/");
    const clearLogin = cookie(LOGIN_COOKIE, "", { maxAgeSec: 0, path: "/auth", secure });
    const opened = sealer!.open(parseCookies(req.headers.cookie)[LOGIN_COOKIE] ?? "");
    const pending = opened ? (JSON.parse(opened) as { state: string; nonce: string; verifier: string; returnTo: string; exp: number }) : null;
    if (!pending || pending.exp < Date.now()) {
      reply.header("set-cookie", clearLogin);
      return reply.code(400).type("text/html").send(page("Sign-in expired", "The sign-in took too long or was started in another browser.", true));
    }
    const providerError = (req.query as Record<string, string>).error;
    try {
      if (providerError) throw new Error(`${providerError}: ${(req.query as Record<string, string>).error_description ?? ""}`.trim());
      const t = await deps.oidc!.finishLogin(new URL(req.url, deps.publicUrl), pending);
      const raw = randomId();
      const hash = sha256(raw);
      await deps.sessions!.create({
        idHash: hash,
        userSub: t.sub,
        userName: t.name,
        email: t.email,
        ...sessionFields(t),
        expiresAt: new Date(Date.now() + deps.maxHours * 3_600_000),
      });
      await deps.audit.record({ actor: { sub: t.sub, name: t.name, email: t.email }, action: "login", details: { roles: appRoles(t.roles) }, ip: req.ip });
      reply.header("set-cookie", [clearLogin, cookie(SESSION_COOKIE, raw, { maxAgeSec: deps.maxHours * 3600, secure })]);
      return reply.redirect(pending.returnTo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("auth.login_failed", { err: msg, cause: (err as { cause?: unknown }).cause });
      await deps.audit.record({ actor: null, action: "login_failed", outcome: "failed", details: { error: msg }, ip: req.ip });
      reply.header("set-cookie", clearLogin);
      return reply.code(400).type("text/html").send(page("Sign-in failed", msg, true));
    }
  });

  app.post("/auth/logout", async (req, reply) => {
    if (deps.mode === "none") return { redirect: "/" };
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let idToken: string | null = null;
    if (raw && deps.sessions) {
      const hash = sha256(raw);
      const s = await deps.sessions.get(hash);
      if (s) {
        idToken = s.idToken;
        await deps.sessions.delete(hash);
        closeSockets(hash, "logged out");
        await deps.audit.record({ actor: toUser(s), action: "logout", ip: req.ip });
      }
    }
    reply.header("set-cookie", cookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure }));
    // Also end the Keycloak SSO session, so "log out" really logs out.
    return { redirect: (await deps.oidc!.endSessionUrl(idToken)) ?? "/" };
  });

  return {
    trackSocket(hash, socket) {
      if (!hash) return () => {};
      const set = sockets.get(hash) ?? new Set();
      set.add(socket);
      sockets.set(hash, set);
      return () => set.delete(socket);
    },
    async sweep() {
      if (!deps.sessions) return;
      for (const hash of await deps.sessions.sweep(idleMs)) closeSockets(hash, "session expired");
    },
  };
}

function page(title: string, message: string, retry = false): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:520px;padding:24px;border:1px solid #2a2f3a;border-radius:8px;background:#151922}a{color:#6aa8ff}</style></head>
<body><main><h2>${esc(title)}</h2><p>${esc(message)}</p>${retry ? '<p><a href="/auth/login">Try again</a></p>' : ""}</main></body></html>`;
}
