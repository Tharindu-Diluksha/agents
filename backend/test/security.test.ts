import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket from "ws";
import { allowedHostnames, hostnameOf, isAllowedHost, isAllowedOrigin, registerRequestGuard } from "../src/security.js";

const allowed = allowedHostnames(["mybox.lan"]);

describe("host and origin checks", () => {
  it("parses hostnames from Host headers", () => {
    expect(hostnameOf("127.0.0.1:5174")).toBe("127.0.0.1");
    expect(hostnameOf("LOCALHOST")).toBe("localhost");
    expect(hostnameOf("[::1]:5174")).toBe("[::1]");
    expect(hostnameOf(undefined)).toBeNull();
  });

  it("accepts only local (or configured) hosts — blocks DNS rebinding", () => {
    expect(isAllowedHost("127.0.0.1:5174", allowed)).toBe(true);
    expect(isAllowedHost("localhost:5173", allowed)).toBe(true);
    expect(isAllowedHost("[::1]:5174", allowed)).toBe(true);
    expect(isAllowedHost("mybox.lan:5174", allowed)).toBe(true);
    expect(isAllowedHost("evil.example:5174", allowed)).toBe(false);
    expect(isAllowedHost("127.0.0.1.evil.example", allowed)).toBe(false);
    expect(isAllowedHost(undefined, allowed)).toBe(false);
  });

  it("accepts only local origins; a missing origin means a non-browser client", () => {
    expect(isAllowedOrigin("http://127.0.0.1:5173", allowed)).toBe(true);
    expect(isAllowedOrigin("http://localhost:5174", allowed)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5174", allowed)).toBe(true);
    expect(isAllowedOrigin(undefined, allowed)).toBe(true);
    expect(isAllowedOrigin("https://evil.example", allowed)).toBe(false);
    expect(isAllowedOrigin("http://localhost.evil.example", allowed)).toBe(false);
    expect(isAllowedOrigin("null", allowed)).toBe(false);
    expect(isAllowedOrigin("chrome-extension://abc", allowed)).toBe(false);
  });
});

describe("registerRequestGuard", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify();
    await app.register(fastifyWebsocket);
    registerRequestGuard(app);
    app.get("/api/thing", async () => ({ ok: true }));
    app.post("/api/thing", async () => ({ ok: true }));
    app.get("/ws/x", { websocket: true }, (socket) => socket.send("hello"));
    await app.ready();
  });
  afterAll(() => app.close());

  const local = { host: "127.0.0.1:5174" };

  it("serves local requests", async () => {
    expect((await app.inject({ url: "/api/thing", headers: local })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/thing", headers: { ...local, origin: "http://127.0.0.1:5173" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/thing", headers: local })).statusCode).toBe(200); // curl
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const r = await app.inject({ url: "/api/thing", headers: { host: "attacker.example:5174" } });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "forbidden_host" });
  });

  it("rejects cross-site state changes but not cross-site reads of GET (which CORS already blocks)", async () => {
    const post = await app.inject({ method: "POST", url: "/api/thing", headers: { ...local, origin: "https://evil.example" } });
    expect(post.statusCode).toBe(403);
    expect(post.json()).toEqual({ error: "forbidden_origin" });
  });

  it("rejects WebSocket connections from other sites (real server + client)", async () => {
    // Same order as index.ts. Closing the server below also proves refused
    // upgrade sockets don't leak (close() would hang on an open socket).
    const server = Fastify();
    await server.register(fastifyWebsocket);
    registerRequestGuard(server);
    server.get("/ws/x", { websocket: true }, (socket) => socket.send("hello"));
    await server.listen({ port: 0, host: "127.0.0.1" });
    const port = (server.server.address() as { port: number }).port;
    const connect = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/x`, { headers: { origin } });
        ws.on("message", (d) => {
          resolve(`message:${String(d)}`);
          ws.terminate();
        });
        ws.on("unexpected-response", (req, res) => {
          resolve(`status:${res.statusCode}`);
        });
        ws.on("error", () => resolve("error"));
      });
    try {
      expect(await connect("https://evil.example")).toBe("status:403");
      expect(await connect("http://localhost:5173")).toBe("message:hello");
    } finally {
      await server.close();
    }
  });
});
