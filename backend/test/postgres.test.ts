import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { acquireDbInstanceLock, createDb, migrate, MIGRATIONS, type Db } from "../src/auth/db.js";
import { PostgresSessionStore } from "../src/auth/sessions.js";
import { PostgresAuditLog } from "../src/auth/audit.js";

/*
 * Runs against a real Postgres when TEST_DATABASE_URL is set (each run uses a
 * fresh schema), e.g.:
 *   docker run -d -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16-alpine
 *   TEST_DATABASE_URL=postgres://postgres:pg@127.0.0.1:55432/postgres npm test
 */
const url = process.env.TEST_DATABASE_URL;
const schema = `t_${process.pid}_${Date.now()}`;

describe.skipIf(!url)("Postgres sessions, audit log and migrations", () => {
  let db: Db;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    const u = new URL(url!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    db = createDb(u.href);
  });
  afterAll(async () => {
    await db?.query(`DROP SCHEMA ${schema} CASCADE`);
    await db?.end();
  });

  it("applies migrations once, recording them", async () => {
    expect(await migrate(db)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await migrate(db)).toEqual([]);
    const r = await db.query("SELECT version FROM schema_migrations ORDER BY version");
    expect(r.rows.map((x) => x.version)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it("stores, refreshes, touches, sweeps and deletes sessions", async () => {
    const store = new PostgresSessionStore(db);
    const now = Date.now();
    const base = {
      userSub: "u-1",
      userName: "Ada",
      email: "ada@example.com",
      roles: ["viewer"],
      idToken: "id.jwt",
      refreshToken: "sealed",
      accessExpiresAt: new Date(now + 60_000),
    };
    await store.create({ ...base, idHash: "h1", expiresAt: new Date(now + 3_600_000) });
    await store.create({ ...base, idHash: "h2", expiresAt: new Date(now - 1) }); // already past absolute expiry

    const s = (await store.get("h1"))!;
    expect(s).toMatchObject({ userSub: "u-1", roles: ["viewer"], email: "ada@example.com" });
    expect(s.createdAt).toBeInstanceOf(Date);

    await store.updateTokens("h1", { roles: ["operator", "viewer"], idToken: "id2", refreshToken: "sealed2", accessExpiresAt: new Date(now + 120_000), userName: "Ada L." });
    expect((await store.get("h1"))!).toMatchObject({ roles: ["operator", "viewer"], idToken: "id2", userName: "Ada L.", email: "ada@example.com" });

    await store.touch("h1");
    expect(await store.sweep(60 * 60_000)).toEqual(["h2"]);
    expect(await store.get("h2")).toBeNull();

    await db.query("UPDATE sessions SET last_seen_at = now() - interval '2 hours' WHERE id_hash = 'h1'");
    expect(await store.sweep(60 * 60_000)).toEqual(["h1"]); // idle for longer than an hour

    await store.create({ ...base, idHash: "h3", expiresAt: new Date(now + 3_600_000) });
    await store.delete("h3");
    expect(await store.get("h3")).toBeNull();
  });

  it("appends audit entries and filters them newest first", async () => {
    const audit = new PostgresAuditLog(db);
    await audit.record({ actor: { sub: "u-1", name: "Ada" }, action: "login", ip: "127.0.0.1" });
    await audit.record({ actor: { sub: "u-1", name: "Ada" }, action: "approve", runId: "R-1", details: { gate: "create_pr" } });
    await audit.record({ actor: { sub: "u-2", name: "Bob" }, action: "access_denied", outcome: "denied", details: { required: "admin" } });

    const all = await audit.list({});
    expect(all.map((e) => e.action)).toEqual(["access_denied", "approve", "login"]);
    expect(all[1]).toMatchObject({ runId: "R-1", userName: "Ada", outcome: "ok", details: { gate: "create_pr" } });
    expect((await audit.list({ runId: "R-1" })).map((e) => e.action)).toEqual(["approve"]);
    expect((await audit.list({ userSub: "u-2" })).map((e) => e.outcome)).toEqual(["denied"]);
    expect((await audit.list({ limit: 1, before: all[0]!.id })).map((e) => e.action)).toEqual(["approve"]);
  });

  it("lets only one backend hold the database instance lock", async () => {
    const release = await acquireDbInstanceLock(db);
    const other = createDb(url!);
    try {
      await expect(acquireDbInstanceLock(other)).rejects.toThrow(/already using this database/);
      await release();
      const again = await acquireDbInstanceLock(other);
      await again();
    } finally {
      await other.end();
    }
  });

  it("never throws into the request path when the audit write fails", async () => {
    const broken = new PostgresAuditLog({ query: async () => Promise.reject(new Error("db down")) } as unknown as Db);
    await expect(broken.record({ actor: null, action: "x" })).resolves.toBeUndefined();
  });
});
