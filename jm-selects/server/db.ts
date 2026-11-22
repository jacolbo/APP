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
  status: Status;
  created_at: number;
  updated_at: number;
  done_at: number | null;
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
    `);
  }

  createSession(clientName: string, folder: string, packageSize: number): SessionRow {
    const now = Date.now();
    const token = crypto.randomBytes(18).toString('base64url');
    const info = this.db
      .prepare(
        `INSERT INTO sessions (token, client_name, folder, package_size, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'in_progress', ?, ?)`,
      )
      .run(token, clientName, folder, packageSize, now, now);
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

  updateSession(id: number, fields: { client_name?: string; package_size?: number }): void {
    const s = this.getSession(id);
    if (!s) return;
    this.db
      .prepare('UPDATE sessions SET client_name = ?, package_size = ?, updated_at = ? WHERE id = ?')
      .run(fields.client_name ?? s.client_name, fields.package_size ?? s.package_size, Date.now(), id);
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

  close(): void {
    this.db.close();
  }
}
