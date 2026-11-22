import type { Response } from 'express';

interface Conn {
  res: Response;
  deviceId: number | null;
}

/**
 * Live updates (Server-Sent Events): every phone/tablet in a session keeps one connection
 * open and is told when anything changes, so selections sync across devices instantly.
 */
export class LiveBus {
  private conns = new Map<number, Set<Conn>>();

  add(sessionId: number, conn: Conn): void {
    const set = this.conns.get(sessionId) ?? new Set();
    set.add(conn);
    this.conns.set(sessionId, set);
  }

  remove(sessionId: number, conn: Conn): void {
    this.conns.get(sessionId)?.delete(conn);
  }

  private send(c: Conn, event: string) {
    try {
      c.res.write(`event: ${event}\ndata: {}\n\n`);
    } catch {
      /* connection already closed */
    }
  }

  notify(sessionId: number): void {
    for (const c of this.conns.get(sessionId) ?? []) this.send(c, 'changed');
  }

  /** Tell one device it was removed, then close its connection. */
  kickDevice(sessionId: number, deviceId: number): void {
    for (const c of [...(this.conns.get(sessionId) ?? [])]) {
      if (c.deviceId === deviceId) {
        this.send(c, 'revoked');
        c.res.end();
        this.remove(sessionId, c);
      }
    }
  }

  /** The link changed: close every connection for the session. */
  kickAll(sessionId: number): void {
    for (const c of [...(this.conns.get(sessionId) ?? [])]) {
      this.send(c, 'gone');
      c.res.end();
    }
    this.conns.delete(sessionId);
  }

  onlineDevices(sessionId: number): Set<number> {
    return new Set([...(this.conns.get(sessionId) ?? [])].map((c) => c.deviceId).filter((d): d is number => d !== null));
  }

  closeAll(): void {
    for (const id of [...this.conns.keys()]) this.kickAll(id);
  }
}
