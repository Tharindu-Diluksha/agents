import { onBeforeUnmount, ref } from "vue";
import type { RunEvent } from "../types.js";

export function useRunSocket(runId: string, onEvent: (ev: RunEvent) => void) {
  const connected = ref(false);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/runs/${runId}`;
  let ws: WebSocket | null = null;
  let reconnectTimer: number | null = null;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => {
      connected.value = true;
    };
    ws.onclose = () => {
      connected.value = false;
      reconnectTimer = window.setTimeout(connect, 1500);
    };
    ws.onerror = () => {
      try { ws?.close(); } catch { /* noop */ }
    };
    ws.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as RunEvent;
        onEvent(ev);
      } catch {
        /* ignore */
      }
    };
  }

  connect();

  onBeforeUnmount(() => {
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    try { ws?.close(); } catch { /* noop */ }
  });

  return { connected };
}
