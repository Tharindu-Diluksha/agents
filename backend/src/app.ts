import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { paths } from "./config.js";
import { registerAuth, type AuthDeps, type AuthHandle } from "./auth/plugin.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { registerWsRoutes } from "./routes/ws.js";
import { registerRequestGuard } from "./security.js";

export interface AppOptions {
  auth: AuthDeps;
  /** Extra hostnames for the Host/Origin guard. */
  allowedHosts: string[];
  /** Serve the built frontend (off in tests). */
  serveFrontend?: boolean;
}

/**
 * Builds the HTTP app without listening. Hook order matters:
 * websocket plugin → request guard (Host/Origin) → auth (session + roles) → routes.
 */
export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; auth: AuthHandle; routes: string[] }> {
  const app = Fastify({ logger: false, trustProxy: process.env.TRUST_PROXY === "true" });
  // Every registered route as "METHOD /pattern", so tests can check the permission table covers them all.
  const routes: string[] = [];
  app.addHook("onRoute", (r) => {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) if (m !== "HEAD") routes.push(`${m} ${r.url}`);
  });
  await app.register(fastifyWebsocket);

  let publicHost: string[] = [];
  try {
    publicHost = [new URL(opts.auth.publicUrl).hostname];
  } catch {
    /* invalid PUBLIC_URL is reported by config validation */
  }
  registerRequestGuard(app, [...opts.allowedHosts, ...publicHost]);
  const auth = registerAuth(app, opts.auth);

  await registerRunsRoutes(app);
  await registerWsRoutes(app, auth);

  if (opts.serveFrontend !== false && existsSync(paths.frontendDist)) {
    await app.register(fastifyStatic, { root: paths.frontendDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws") || req.url.startsWith("/auth")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else if (opts.serveFrontend !== false) {
    app.get("/", async () => ({
      status: "backend_only",
      message: "Frontend not built. Use `npm run dev` from the repo root for the Vue dev server, or run `npm --prefix frontend run build`.",
    }));
  }
  return { app, auth, routes };
}
