import type { Db } from "./db.js";

/** A logged-in user's session, as the rest of the backend sees it. */
export interface Session {
  idHash: string;
  userSub: string;
  userName: string;
  email: string | null;
  roles: string[];
  idToken: string | null;
  /** Sealed refresh token. */
  refreshToken: string | null;
  accessExpiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export type NewSession = Omit<Session, "createdAt" | "lastSeenAt">;
export type TokenUpdate = Pick<Session, "roles" | "idToken" | "refreshToken" | "accessExpiresAt"> & Partial<Pick<Session, "userName" | "email">>;

export interface SessionStore {
  create(s: NewSession): Promise<void>;
  get(idHash: string): Promise<Session | null>;
  updateTokens(idHash: string, u: TokenUpdate): Promise<void>;
  touch(idHash: string): Promise<void>;
  delete(idHash: string): Promise<void>;
  /** Removes sessions past their absolute expiry or idle for longer than idleMs. Returns their hashes. */
  sweep(idleMs: number): Promise<string[]>;
}

type Row = {
  id_hash: string;
  user_sub: string;
  user_name: string;
  email: string | null;
  roles: string[];
  id_token: string | null;
  refresh_token: string | null;
  access_expires_at: Date;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
};

const fromRow = (r: Row): Session => ({
  idHash: r.id_hash,
  userSub: r.user_sub,
  userName: r.user_name,
  email: r.email,
  roles: r.roles,
  idToken: r.id_token,
  refreshToken: r.refresh_token,
  accessExpiresAt: r.access_expires_at,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
});

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly db: Db) {}

  async create(s: NewSession): Promise<void> {
    await this.db.query(
      `INSERT INTO sessions (id_hash, user_sub, user_name, email, roles, id_token, refresh_token, access_expires_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [s.idHash, s.userSub, s.userName, s.email, s.roles, s.idToken, s.refreshToken, s.accessExpiresAt, s.expiresAt],
    );
  }

  async get(idHash: string): Promise<Session | null> {
    const r = await this.db.query<Row>("SELECT * FROM sessions WHERE id_hash = $1", [idHash]);
    return r.rows[0] ? fromRow(r.rows[0]) : null;
  }

  async updateTokens(idHash: string, u: TokenUpdate): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET roles = $2, id_token = $3, refresh_token = $4, access_expires_at = $5,
              user_name = COALESCE($6, user_name), email = COALESCE($7, email), last_seen_at = now()
       WHERE id_hash = $1`,
      [idHash, u.roles, u.idToken, u.refreshToken, u.accessExpiresAt, u.userName ?? null, u.email ?? null],
    );
  }

  async touch(idHash: string): Promise<void> {
    await this.db.query("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1", [idHash]);
  }

  async delete(idHash: string): Promise<void> {
    await this.db.query("DELETE FROM sessions WHERE id_hash = $1", [idHash]);
  }

  async sweep(idleMs: number): Promise<string[]> {
    const r = await this.db.query<{ id_hash: string }>(
      "DELETE FROM sessions WHERE expires_at < now() OR last_seen_at < now() - ($1::double precision * interval '1 millisecond') RETURNING id_hash",
      [idleMs],
    );
    return r.rows.map((x) => x.id_hash);
  }
}

/** For SESSION_STORE=memory and tests: same behaviour, nothing survives a restart. */
export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, Session>();

  async create(s: NewSession): Promise<void> {
    const now = new Date();
    this.map.set(s.idHash, { ...s, createdAt: now, lastSeenAt: now });
  }
  async get(idHash: string): Promise<Session | null> {
    const s = this.map.get(idHash);
    return s ? { ...s, roles: [...s.roles] } : null;
  }
  async updateTokens(idHash: string, u: TokenUpdate): Promise<void> {
    const s = this.map.get(idHash);
    if (!s) return;
    this.map.set(idHash, {
      ...s,
      ...u,
      userName: u.userName ?? s.userName,
      email: u.email ?? s.email,
      lastSeenAt: new Date(),
    });
  }
  async touch(idHash: string): Promise<void> {
    const s = this.map.get(idHash);
    if (s) s.lastSeenAt = new Date();
  }
  async delete(idHash: string): Promise<void> {
    this.map.delete(idHash);
  }
  async sweep(idleMs: number): Promise<string[]> {
    const now = Date.now();
    const gone: string[] = [];
    for (const [k, s] of this.map) {
      if (s.expiresAt.getTime() < now || s.lastSeenAt.getTime() < now - idleMs) {
        this.map.delete(k);
        gone.push(k);
      }
    }
    return gone;
  }
}
