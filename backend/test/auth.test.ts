import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { FastifyInstance } from "fastify";

/*
 * End-to-end auth tests: the real app (buildApp) in AUTH_MODE=keycloak against
 * a fake OpenID provider that signs tokens like Keycloak. Covers login with
 * PKCE/state/nonce, role enforcement on HTTP and WebSocket, token refresh
 * picking up role changes, revocation in the IdP, logout closing sockets, and
 * open-redirect protection.
 */

const tmp = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  return fs.mkdtempSync(path.join(os.tmpdir(), "auth-test-"));
});
vi.mock("../src/config.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/config.js")>();
  const { join } = await import("node:path");
  return { ...orig, paths: { ...orig.paths, repoRoot: tmp, runsDir: join(tmp, "runs"), sessionsDir: join(tmp, "sessions") } };
});

const { startFakeOidc } = await import("./fakeOidc.js");
const { buildApp } = await import("../src/app.js");
const { OidcClient } = await import("../src/auth/oidc.js");
const { MemorySessionStore } = await import("../src/auth/sessions.js");
const { ROUTE_RULES, allows, requirementFor } = await import("../src/auth/authz.js");
const { setAuditLog } = await import("../src/orchestrator/activity.js");
const { createRun } = await import("../src/orchestrator/runStore.js");

const CLIENT = "orchestrator-web";
const SECRET = "test-secret";
const PUBLIC = "http://localhost:5174";

/** In-memory audit log so tests can assert what was recorded. */
class MemoryAudit {
  readonly enabled = true;
  entries: Array<{ action: string; outcome?: string; actor: { name: string } | null; runId?: string | null; details?: Record<string, unknown> }> = [];
  async record(e: (typeof this.entries)[number]) {
    this.entries.push(e);
  }
  async list() {
    return [];
  }
}

let idp: Awaited<ReturnType<typeof startFakeOidc>>;
let app: FastifyInstance;
let routes: string[];
let sessions: InstanceType<typeof MemorySessionStore>;
const audit = new MemoryAudit();

beforeAll(async () => {
  idp = await startFakeOidc(CLIENT, SECRET);
  sessions = new MemorySessionStore();
  setAuditLog(audit as never);
  ({ app, routes } = await buildApp({
    allowedHosts: [],
    serveFrontend: false,
    auth: {
      mode: "keycloak",
      sessions,
      audit: audit as never,
      oidc: new OidcClient({ issuer: idp.issuer, clientId: CLIENT, clientSecret: SECRET, redirectUri: `${PUBLIC}/auth/callback`, postLogoutRedirectUri: `${PUBLIC}/` }),
      sessionSecret: "x".repeat(40),
      publicUrl: PUBLIC,
      idleMinutes: 60,
      maxHours: 24,
    },
  }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await idp.close();
});

const H = { host: "localhost:5174" };
const cookieOf = (res: { headers: Record<string, unknown> }, name: string): string | null => {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const c = list.find((x) => x.startsWith(`${name}=`));
  return c ? c.split(";")[0]!.slice(name.length + 1) : null;
};

/** Runs the browser side of the login: app → IdP → callback. Returns the session cookie and the final redirect. */
async function login(returnTo = "/runs/x"): Promise<{ session: string; location: string }> {
  const start = await app.inject({ url: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`, headers: H });
  expect(start.statusCode).toBe(302);
  const loginCookie = cookieOf(start, "orch_login")!;
  const atIdp = await fetch(start.headers.location as string, { redirect: "manual" });
  expect(atIdp.status).toBe(302);
  const back = new URL(atIdp.headers.get("location")!);
  const cb = await app.inject({ url: `${back.pathname}${back.search}`, headers: { ...H, cookie: `orch_login=${loginCookie}` } });
  expect(cb.statusCode, cb.body).toBe(302);
  return { session: cookieOf(cb, "orch_session")!, location: cb.headers.location as string };
}

describe("permission table", () => {
  it("covers every /api, /ws and /auth route the app registers", () => {
    const relevant = routes.filter((r) => /^\S+ \/(api|ws|auth)\b/.test(r));
    expect(relevant.length).toBeGreaterThan(20);
    const missing = relevant.filter((r) => !(r in ROUTE_RULES));
    expect(missing).toEqual([]);
  });

  it("denies unlisted API routes by default and leaves the SPA public", () => {
    expect(requirementFor("GET", "/api/new-thing", "/api/new-thing")).toBe("admin");
    expect(requirementFor("GET", undefined, "/assets/index.js")).toBe("public");
  });

  it("role semantics: every role can view, admin can do everything", () => {
    expect(allows(["operator"], "viewer")).toBe(true);
    expect(allows(["operator"], "approver")).toBe(false);
    expect(allows(["approver"], "operator")).toBe(false);
    expect(allows(["admin"], "approver")).toBe(true);
    expect(allows(["default-roles-x"], "viewer")).toBe(false);
  });
});

describe("login flow", () => {
  it("rejects anonymous API and WebSocket access", async () => {
    const r = await app.inject({ url: "/api/runs", headers: H });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toMatchObject({ error: "unauthenticated", login: "/auth/login" });
    expect((await app.inject({ url: "/auth/me", headers: H })).statusCode).toBe(401);
  });

  it("logs in with PKCE, state and nonce, and lands on returnTo", async () => {
    idp.user = { sub: "u-1", name: "Ada Lovelace", email: "ada@example.com", roles: ["viewer", "default-roles-test"] };
    const { session, location } = await login("/runs/abc?tab=1");
    expect(location).toBe("/runs/abc?tab=1");
    expect(session.length).toBeGreaterThan(30);
    const me = await app.inject({ url: "/auth/me", headers: { ...H, cookie: `orch_session=${session}` } });
    expect(me.json()).toEqual({ authMode: "keycloak", user: { sub: "u-1", name: "Ada Lovelace", email: "ada@example.com", roles: ["viewer"] } });
    const req = idp.tokenRequests.find((t) => t.grant_type === "authorization_code")!;
    expect(req.code_verifier).toBeTruthy();
    expect(audit.entries.some((e) => e.action === "login" && e.actor?.name === "Ada Lovelace")).toBe(true);
  });

  it("never redirects off-site after login", async () => {
    expect((await login("//evil.example/x")).location).toBe("/");
    expect((await login("https://evil.example")).location).toBe("/");
  });

  it("rejects a callback without the login cookie or with a forged state", async () => {
    const start = await app.inject({ url: "/auth/login", headers: H });
    const atIdp = await fetch(start.headers.location as string, { redirect: "manual" });
    const back = new URL(atIdp.headers.get("location")!);
    const noCookie = await app.inject({ url: `${back.pathname}${back.search}`, headers: H });
    expect(noCookie.statusCode).toBe(400);
    back.searchParams.set("state", "forged");
    const forged = await app.inject({ url: `${back.pathname}${back.search}`, headers: { ...H, cookie: `orch_login=${cookieOf(start, "orch_login")}` } });
    expect(forged.statusCode).toBe(400);
    expect(audit.entries.some((e) => e.action === "login_failed")).toBe(true);
  });
});

describe("authorization", () => {
  it("lets a viewer read but not launch, approve or delete, and audits denials", async () => {
    idp.user.roles = ["viewer"];
    const { session } = await login();
    const as = { ...H, cookie: `orch_session=${session}`, origin: "http://localhost:5174" };
    expect((await app.inject({ url: "/api/runs", headers: as })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/runs", headers: as, payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/runs/x/approve", headers: as, payload: { decision: "approve" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: "/api/runs/x", headers: as })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/audit", headers: as })).statusCode).toBe(403);
    expect(audit.entries.filter((e) => e.action === "access_denied").length).toBeGreaterThanOrEqual(4);
  });

  it("picks up role changes from Keycloak on token refresh", async () => {
    idp.user.roles = ["viewer"];
    idp.expiresIn = 1; // already inside the refresh window on the next request
    const { session } = await login();
    const as = { ...H, cookie: `orch_session=${session}`, origin: "http://localhost:5174" };
    expect((await app.inject({ method: "POST", url: "/api/runs", headers: as, payload: {} })).statusCode).toBe(403);
    idp.user.roles = ["operator"];
    const r = await app.inject({ method: "POST", url: "/api/runs", headers: as, payload: {} });
    expect(r.statusCode).toBe(400); // allowed through to validation
    expect(idp.tokenRequests.filter((t) => t.grant_type === "refresh_token").length).toBeGreaterThan(0);
    idp.expiresIn = 300;
  });

  it("ends the session when Keycloak revokes it", async () => {
    idp.user.roles = ["viewer"];
    idp.expiresIn = 1;
    const { session } = await login();
    const as = { ...H, cookie: `orch_session=${session}` };
    expect((await app.inject({ url: "/api/runs", headers: as })).statusCode).toBe(200);
    idp.revokeAll = true; // e.g. an admin logged the user out or disabled them in Keycloak
    expect((await app.inject({ url: "/api/runs", headers: as })).statusCode).toBe(401);
    expect(audit.entries.some((e) => e.action === "session_ended")).toBe(true);
    idp.revokeAll = false;
    idp.expiresIn = 300;
  });

  it("records who launched and who acted on a run", async () => {
    idp.user = { sub: "u-2", name: "Grace Hopper", email: "grace@example.com", roles: ["operator"] };
    const { session } = await login();
    createRun({
      runId: "R-1",
      label: "R-1",
      source: { kind: "manual", type: "feature", title: "t", description: "d", acceptanceCriteria: [] },
      repos: [{ path: tmp, baseBranch: "main", aiGuidelinePath: null }],
    });
    const as = { ...H, cookie: `orch_session=${session}`, origin: "http://localhost:5174" };
    expect((await app.inject({ method: "POST", url: "/api/runs/R-1/abort", headers: as })).statusCode).toBe(200);
    const run = (await app.inject({ url: "/api/runs/R-1", headers: as })).json();
    expect(run.activity).toEqual([expect.objectContaining({ action: "abort", by: { sub: "u-2", name: "Grace Hopper" } })]);
    expect(audit.entries.some((e) => e.action === "abort" && e.runId === "R-1")).toBe(true);
  });
});

describe("WebSockets and logout", () => {
  it("authenticates WebSockets with the session cookie and closes them on logout", async () => {
    idp.user = { sub: "u-3", name: "Linus", email: "l@example.com", roles: ["viewer"] };
    const { session } = await login();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const ws = (cookie?: string) =>
      new WebSocket(`${address.replace("http", "ws")}/ws/runs`, { headers: { host: "localhost:5174", origin: "http://localhost:5174", ...(cookie ? { cookie } : {}) } });

    const anon = await new Promise<string>((r) => {
      const s = ws();
      s.on("unexpected-response", (_q, res) => r(`status:${res.statusCode}`));
      s.on("open", () => r("open"));
    });
    expect(anon).toBe("status:401");

    const s = ws(`orch_session=${session}`);
    const hello = await new Promise<string>((r) => s.once("message", (d) => r(String(d))));
    expect(JSON.parse(hello)).toMatchObject({ type: "ws.hello" });
    const closed = new Promise<number>((r) => s.on("close", (code) => r(code)));

    const out = await app.inject({ method: "POST", url: "/auth/logout", headers: { ...H, cookie: `orch_session=${session}`, origin: "http://localhost:5174" } });
    expect(out.json().redirect).toMatch(new RegExp(`^${idp.issuer}/logout\\?.*id_token_hint=`));
    expect(cookieOf(out, "orch_session")).toBe("");
    expect(await closed).toBe(4401);
    expect((await app.inject({ url: "/api/runs", headers: { ...H, cookie: `orch_session=${session}` } })).statusCode).toBe(401);
  });
});
