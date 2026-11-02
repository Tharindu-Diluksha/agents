import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { existsSync, mkdirSync } from "node:fs";
import { config, paths } from "./config.js";
import { log } from "./log.js";
import { recoverRuns } from "./orchestrator/recovery.js";
import { registerRunsRoutes } from "./routes/runs.js";
import { registerWsRoutes } from "./routes/ws.js";

async function main() {
  for (const dir of [paths.runsDir, paths.sessionsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  const app = Fastify({ logger: false });

  await app.register(fastifyWebsocket);

  await registerRunsRoutes(app);
  await registerWsRoutes(app);

  if (existsSync(paths.frontendDist)) {
    await app.register(fastifyStatic, {
      root: paths.frontendDist,
      prefix: "/",
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) {
        reply.code(404).send({ error: "not_found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    app.get("/", async () => ({
      status: "backend_only",
      message: "Frontend not built. Use `npm run dev` from the repo root for the Vue dev server, or run `npm --prefix frontend run build`.",
    }));
  }

  await app.listen({ port: config.port, host: config.host });
  log.info("backend.listening", { port: config.port, host: config.host });

  try {
    recoverRuns();
  } catch (err) {
    log.error("backend.recovery_failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

main().catch((err) => {
  log.error("backend.fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
