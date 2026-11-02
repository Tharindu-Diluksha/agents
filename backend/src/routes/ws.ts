import type { FastifyInstance } from "fastify";
import { subscribe, subscribeAll } from "../events.js";

export async function registerWsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ws/runs/:id", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const unsubscribe = subscribe(id, (ev) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        /* socket may be closing */
      }
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    socket.send(JSON.stringify({ type: "ws.hello", runId: id }));
  });

  app.get("/ws/runs", { websocket: true }, (socket) => {
    const unsubscribe = subscribeAll((ev) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        /* ignore */
      }
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
    socket.send(JSON.stringify({ type: "ws.hello", scope: "all" }));
  });
}
