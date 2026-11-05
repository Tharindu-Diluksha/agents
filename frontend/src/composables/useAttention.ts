import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useRunsStore } from "../stores/runs.js";
import type { RunEvent } from "../types.js";

/**
 * App-wide: listens to every run's events, keeps the run list fresh, shows the
 * number of runs waiting on the user in the tab title, and raises a desktop
 * notification when a run needs a decision, pauses, fails or finishes while
 * the tab is in the background.
 */
export function useAttention() {
  const store = useRunsStore();
  const router = useRouter();
  const attention = computed(() => store.attention);
  const notifyPermission = ref<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    notifyPermission.value = await Notification.requestPermission();
  }

  function notify(runId: string, title: string, body: string) {
    if (notifyPermission.value !== "granted" || !document.hidden) return;
    const label = store.runs.find((r) => r.runId === runId)?.label ?? runId;
    const n = new Notification(`${label}: ${title}`, { body, tag: `${runId}:${title}` });
    n.onclick = () => {
      window.focus();
      void router.push(`/runs/${runId}`);
      n.close();
    };
  }

  let refreshTimer: number | null = null;
  function scheduleRefresh() {
    if (refreshTimer !== null) return;
    refreshTimer = window.setTimeout(() => {
      refreshTimer = null;
      void store.refresh();
    }, 300);
  }

  function onEvent(ev: RunEvent) {
    switch (ev.type) {
      case "approval.requested":
        notify(ev.runId, "needs your approval", ev.summary);
        break;
      case "run.failed":
        notify(ev.runId, "failed", ev.error);
        break;
      case "run.transitioned":
        if (ev.to === "paused") notify(ev.runId, "paused", "Open the run to see why.");
        if (ev.to === "done") notify(ev.runId, "done", "PRs created.");
        break;
      case "run.overlaps":
        if (ev.overlaps.length) notify(ev.runId, "overlaps another run", ev.overlaps.map((o) => `${o.otherLabel}: ${o.files.join(", ")}`).join("; "));
        break;
    }
    if (
      ev.type === "run.created" ||
      ev.type === "run.transitioned" ||
      ev.type === "run.failed" ||
      ev.type === "approval.requested" ||
      ev.type === "approval.resolved" ||
      ev.type === "run.overlaps" ||
      ev.type === "run.removed" ||
      ev.type === "role.ended"
    ) {
      scheduleRefresh();
    }
  }

  let ws: WebSocket | null = null;
  let reconnect: number | null = null;
  let closed = false;
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/runs`);
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data) as RunEvent);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      reconnect = window.setTimeout(connect, 2000);
      scheduleRefresh(); // catch up on anything missed while disconnected
    };
    ws.onerror = () => ws?.close();
  }

  const baseTitle = document.title || "Agent Orchestrator";
  watch(
    () => attention.value.length,
    (n) => {
      document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle;
    },
    { immediate: true },
  );

  onMounted(() => {
    void store.refresh();
    connect();
  });
  onBeforeUnmount(() => {
    closed = true;
    if (reconnect !== null) window.clearTimeout(reconnect);
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    ws?.close();
  });

  return { attention, notifyPermission, enableNotifications };
}
