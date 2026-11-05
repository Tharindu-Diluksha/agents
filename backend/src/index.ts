import { existsSync, mkdirSync } from "node:fs";
import { config, paths, validateAuthConfig } from "./config.js";
import { buildApp } from "./app.js";
import { NoAuditLog, PostgresAuditLog } from "./auth/audit.js";
import { acquireDbInstanceLock, createDb, migrate } from "./auth/db.js";
import { OidcClient } from "./auth/oidc.js";
import { MemorySessionStore, PostgresSessionStore } from "./auth/sessions.js";
import { setAuditLog } from "./orchestrator/activity.js";
import { log } from "./log.js";
import { join } from "node:path";
import { acquireInstanceLock, InstanceLockError } from "./orchestrator/instanceLock.js";
import { recoverRuns } from "./orchestrator/recovery.js";

async function main() {
  for (const dir of [paths.runsDir, paths.sessionsDir]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  // Only one backend may own runs/ (state is cached in memory).
  let releaseLock: () => void;
  try {
    releaseLock = await acquireInstanceLock(join(paths.runsDir, ".orchestrator.lock"), { port: config.port });
  } catch (err) {
    if (err instanceof InstanceLockError) {
      log.error("backend.already_running", { err: err.message });
      process.exit(1);
    }
    throw err;
  }
  process.on("exit", releaseLock);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      releaseLock();
      process.exit(0);
    });
  }

  validateAuthConfig(config);
  const { db, sessions, audit, oidc } = await setupAuthBackends();
  if (db) {
    // A second guard for containers sharing a database: the file lock above covers the state folder.
    try {
      const releaseDbLock = await acquireDbInstanceLock(db);
      process.on("exit", () => void releaseDbLock());
    } catch (err) {
      log.error("backend.already_running", { err: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    }
  }
  setAuditLog(audit);

  const { app, auth } = await buildApp({
    allowedHosts: config.allowedHosts,
    auth: {
      mode: config.auth.mode,
      sessions,
      oidc,
      audit,
      sessionSecret: config.auth.sessionSecret,
      publicUrl: config.auth.publicUrl,
      idleMinutes: config.auth.idleMinutes,
      maxHours: config.auth.maxHours,
    },
  });
  const sweeper = setInterval(() => void auth.sweep().catch((err) => log.warn("auth.sweep_failed", { err: String(err) })), 60_000);
  sweeper.unref();
  process.on("exit", () => void db?.end());

  await app.listen({ port: config.port, host: config.host });
  log.info("backend.listening", { port: config.port, host: config.host, auth: config.auth.mode, audit: audit.enabled });

  try {
    recoverRuns();
  } catch (err) {
    log.error("backend.recovery_failed", { err: err instanceof Error ? err.message : String(err) });
  }
}

/** Postgres (sessions + audit) and the OIDC client, as configured. */
async function setupAuthBackends() {
  const db = config.databaseUrl ? createDb(config.databaseUrl) : null;
  if (db) await migrate(db);
  const audit = db ? new PostgresAuditLog(db) : new NoAuditLog();
  if (config.auth.mode !== "keycloak") return { db, sessions: undefined, audit, oidc: undefined };
  const sessions = config.auth.sessionStore === "memory" || !db ? new MemorySessionStore() : new PostgresSessionStore(db);
  const oidc = new OidcClient({
    issuer: config.auth.issuer,
    clientId: config.auth.clientId,
    clientSecret: config.auth.clientSecret,
    internalUrl: config.auth.internalUrl || undefined,
    redirectUri: `${config.auth.publicUrl}/auth/callback`,
    postLogoutRedirectUri: `${config.auth.publicUrl}/`,
  });
  return { db, sessions, audit, oidc };
}

main().catch((err) => {
  log.error("backend.fatal", { err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
