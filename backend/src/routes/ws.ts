import type { FastifyInstance } from "fastify";
import type { AuthHandle } from "../auth/plugin.js";
import { subscribe, subscribeAll } from "../events.js";

/** Sockets are tied to the user's session: logout or expiry closes them (code 4401). */
export async function registerWsRoutes(app: FastifyInstance, auth: AuthHandle): Promise<void> {
  app.get("/ws/runs/:id", { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    const unsubscribe = subscribe(id, (ev) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        /* socket may be closing */
      }
    });
    const untrack = auth.trackSocket(req.sessionHash, socket);
    socket.on("close", () => (unsubscribe(), untrack()));
    socket.on("error", () => (unsubscribe(), untrack()));
    socket.send(JSON.stringify({ type: "ws.hello", runId: id }));
  });

  app.get("/ws/runs", { websocket: true }, (socket, req) => {
    const unsubscribe = subscribeAll((ev) => {
      try {
        socket.send(JSON.stringify(ev));
      } catch {
        /* ignore */
      }
    });
    const untrack = auth.trackSocket(req.sessionHash, socket);
    socket.on("close", () => (unsubscribe(), untrack()));
    socket.on("error", () => (unsubscribe(), untrack()));
    socket.send(JSON.stringify({ type: "ws.hello", scope: "all" }));
  });
}
