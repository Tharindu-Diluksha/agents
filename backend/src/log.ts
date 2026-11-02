import { config } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(config.logLevel as Level) ?? "info"] ?? order.info;

function emit(level: Level, msg: string, extra?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = { t: new Date().toISOString(), level, msg, ...extra };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit("debug", msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit("error", msg, extra),
};
