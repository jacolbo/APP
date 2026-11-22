import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import path from 'node:path';

export type Status = 'in_progress' | 'done';

export interface SessionRow {
  id: number;
  token: string;
  client_name: string;
  folder: string;
  package_size: number;
  extra_price: number;
  join_failures: number;
  status: Status;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

export interface DeviceRow {
  id: number;
  session_id: number;
  key_hash: string;
  label: string;
  via: 'name' | 'tablet';
  created_at: number;
  last_seen: number;
  revoked_at: number | null;
}

export interface PickRow {
  file_name: string;
  selected: number;
  stars: number;
  updated_at: number;
}

export class Store {
  readonly db: Database.Database;

  constructor(dataDir: string) {
    this.db = new Database(path.join(dataDir, 'jm-selects.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL UNIQUE,
        client_name TEXT NOT NULL,
        folder TEXT NOT NULL,
        package_size INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS picks (
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        selected INTEGER NOT NULL DEFAULT 0,
        stars INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, file_name)
      );
      CREATE TABLE IF NOT EXISTS raw_jobs (
        session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        state TEXT NOT NULL,
        report TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    // Older databases: add newer columns.
    const cols = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'extra_price')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN extra_price INTEGER NOT NULL DEFAULT 250');
    }
    if (!cols.some((c) => c.name === 'join_failures')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN join_failures INTEGER NOT NULL DEFAULT 0');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        via TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS devices_session ON devices(session_id);
    `);
    // A job that was running when the app stopped can't still be running.
    this.db
      .prepare(`UPDATE raw_jobs SET state = 'interrupted' WHERE state IN ('queued', 'running')`)
      .run();
  }

  createSession(clientName: string, folder: string, packageSize: number, extraPrice: number): SessionRow {
    const now = Date.now();
    const token = crypto.randomBytes(18).toString('base64url');
    const info = this.db
      .prepare(
        `INSERT INTO sessions (token, client_name, folder, package_size, extra_price, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?)`,
      )
      .run(token, clientName, folder, packageSize, extraPrice, now, now);
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getSessionByToken(token: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionRow | undefined;
  }

  listSessions(): (SessionRow & { selected_count: number; rated_count: number })[] {
    return this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM picks p WHERE p.session_id = s.id AND p.selected = 1) AS selected_count,
           (SELECT COUNT(*) FROM picks p WHERE p.session_id = s.id AND p.stars > 0) AS rated_count
         FROM sessions s ORDER BY s.updated_at DESC`,
      )
      .all() as (SessionRow & { selected_count: number; rated_count: number })[];
  }

  updateSession(id: number, fields: { client_name?: string; package_size?: number; extra_price?: number }): void {
    const s = this.getSession(id);
    if (!s) return;
    this.db
      .prepare('UPDATE sessions SET client_name = ?, package_size = ?, extra_price = ?, updated_at = ? WHERE id = ?')
      .run(
        fields.client_name ?? s.client_name,
        fields.package_size ?? s.package_size,
        fields.extra_price ?? s.extra_price,
        Date.now(),
        id,
      );
  }

  setStatus(id: number, status: Status): void {
    const now = Date.now();
    this.db
      .prepare('UPDATE sessions SET status = ?, done_at = ?, updated_at = ? WHERE id = ?')
      .run(status, status === 'done' ? now : null, now, id);
  }

  resetSession(id: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM picks WHERE session_id = ?').run(id);
      this.setStatus(id, 'in_progress');
    })();
  }

  deleteSession(id: number): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  getPicks(sessionId: number): PickRow[] {
    return this.db
      .prepare('SELECT file_name, selected, stars, updated_at FROM picks WHERE session_id = ?')
      .all(sessionId) as PickRow[];
  }

  setPick(sessionId: number, fileName: string, change: { selected?: boolean; stars?: number }): PickRow {
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT file_name, selected, stars, updated_at FROM picks WHERE session_id = ? AND file_name = ?')
      .get(sessionId, fileName) as PickRow | undefined;
    const selected = change.selected === undefined ? (existing?.selected ?? 0) : change.selected ? 1 : 0;
    const stars = change.stars === undefined ? (existing?.stars ?? 0) : change.stars;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO picks (session_id, file_name, selected, stars, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(session_id, file_name) DO UPDATE SET selected = excluded.selected, stars = excluded.stars, updated_at = excluded.updated_at`,
        )
        .run(sessionId, fileName, selected, stars, now);
      this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, sessionId);
    })();
    return { file_name: fileName, selected, stars, updated_at: now };
  }

  getRawJob(sessionId: number): { state: string; report: string; updated_at: number } | undefined {
    return this.db.prepare('SELECT state, report, updated_at FROM raw_jobs WHERE session_id = ?').get(sessionId) as
      | { state: string; report: string; updated_at: number }
      | undefined;
  }

  saveRawJob(sessionId: number, state: string, report: unknown): void {
    if (!this.getSession(sessionId)) return; // session deleted meanwhile
    this.db
      .prepare(
        `INSERT INTO raw_jobs (session_id, state, report, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET state = excluded.state, report = excluded.report, updated_at = excluded.updated_at`,
      )
      .run(sessionId, state, JSON.stringify(report), Date.now());
  }

  rawJobStates(): Map<number, string> {
    const rows = this.db.prepare('SELECT session_id, state FROM raw_jobs').all() as { session_id: number; state: string }[];
    return new Map(rows.map((r) => [r.session_id, r.state]));
  }

  // ---------- devices (phones/tablets allowed into a session) ----------

  addDevice(sessionId: number, keyHash: string, label: string, via: 'name' | 'tablet'): DeviceRow {
    const now = Date.now();
    const info = this.db
      .prepare('INSERT INTO devices (session_id, key_hash, label, via, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sessionId, keyHash, label, via, now, now);
    return this.db.prepare('SELECT * FROM devices WHERE id = ?').get(Number(info.lastInsertRowid)) as DeviceRow;
  }

  deviceByKey(sessionId: number, keyHash: string): DeviceRow | undefined {
    return this.db.prepare('SELECT * FROM devices WHERE session_id = ? AND key_hash = ?').get(sessionId, keyHash) as
      | DeviceRow
      | undefined;
  }

  listDevices(sessionId: number): DeviceRow[] {
    return this.db.prepare('SELECT * FROM devices WHERE session_id = ? ORDER BY created_at').all(sessionId) as DeviceRow[];
  }

  touchDevice(id: number): void {
    this.db.prepare('UPDATE devices SET last_seen = ? WHERE id = ?').run(Date.now(), id);
  }

  revokeDevice(sessionId: number, deviceId: number): boolean {
    const r = this.db
      .prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND session_id = ? AND revoked_at IS NULL')
      .run(Date.now(), deviceId, sessionId);
    return r.changes > 0;
  }

  setJoinFailures(sessionId: number, n: number): void {
    this.db.prepare('UPDATE sessions SET join_failures = ? WHERE id = ?').run(n, sessionId);
  }

  /** New link for the session: the old link stops working and every device has to join again. */
  regenerateToken(sessionId: number): SessionRow | undefined {
    const token = crypto.randomBytes(18).toString('base64url');
    this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET token = ?, join_failures = 0, updated_at = ? WHERE id = ?').run(token, Date.now(), sessionId);
      // Forget every device: they must scan the new code and confirm the name again.
      this.db.prepare('DELETE FROM devices WHERE session_id = ?').run(sessionId);
    })();
    return this.getSession(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
