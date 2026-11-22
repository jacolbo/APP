import type { Store, SessionRow } from './db.js';
import { resolveInside } from './paths.js';
import {
  UnsafeDestination,
  cleanPartials,
  copyOne,
  ensureProjectDir,
  indexRaws,
  isWritable,
  matchRaws,
  projectSegments,
} from './raws.js';

export type JobState = 'queued' | 'running' | 'done' | 'done_with_issues' | 'failed' | 'interrupted';

export interface RawReport {
  state: JobState;
  /** Destination relative to the projects folder, e.g. "2026/Week 47/Naidoo Family". */
  destination: string | null;
  totalFiles: number;
  doneFiles: number;
  copied: number;
  alreadyThere: number;
  totalBytes: number;
  doneBytes: number;
  missing: string[]; // selected JPEGs with no RAW found
  problems: string[]; // conflicts and failures
  multipleMatches: string[]; // JPEGs where more than one RAW had the same name (first one used)
  startedAt: number | null;
  finishedAt: number | null;
  message: string | null;
}

const emptyReport = (state: JobState): RawReport => ({
  state,
  destination: null,
  totalFiles: 0,
  doneFiles: 0,
  copied: 0,
  alreadyThere: 0,
  totalBytes: 0,
  doneBytes: 0,
  missing: [],
  problems: [],
  multipleMatches: [],
  startedAt: null,
  finishedAt: null,
  message: null,
});

/**
 * Copies the RAWs for a session's hearted photos into the projects folder, one session at
 * a time, in the background. Only ever reads from the photos folder and only ever creates
 * files inside the projects folder.
 */
export class RawCopier {
  private queue: number[] = [];
  private live = new Map<number, RawReport>();
  private busy = false;
  /** Resolves when the queue is empty (used by tests). */
  idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  constructor(
    private store: Store,
    private opts: { photosRoot: string; projectsRoot: string | null; backupSuffix: string },
  ) {}

  enabled(): boolean {
    return this.opts.projectsRoot !== null;
  }

  status(sessionId: number): RawReport | null {
    const live = this.live.get(sessionId);
    if (live) return live;
    const row = this.store.getRawJob(sessionId);
    if (!row) return null;
    const report = JSON.parse(row.report) as RawReport;
    report.state = row.state as JobState;
    if (report.state === 'interrupted') report.message = 'Stopped when the app restarted. Press “Re-copy RAWs” to finish.';
    return report;
  }

  enqueue(sessionId: number): RawReport {
    if (!this.queue.includes(sessionId) && this.live.get(sessionId)?.state !== 'running') {
      this.queue.push(sessionId);
    }
    const queued = this.live.get(sessionId) ?? emptyReport('queued');
    if (queued.state !== 'running') {
      queued.state = 'queued';
      this.live.set(sessionId, queued);
      this.store.saveRawJob(sessionId, 'queued', queued);
    }
    if (!this.busy) {
      this.idle = new Promise((r) => (this.resolveIdle = r));
      void this.drain();
    }
    return queued;
  }

  private async drain() {
    this.busy = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        const s = this.store.getSession(id);
        if (!s) {
          this.live.delete(id);
          continue;
        }
        const report = await this.run(s).catch((e) => {
          const r = this.live.get(id) ?? emptyReport('failed');
          r.state = 'failed';
          r.message = e instanceof UnsafeDestination ? e.message : `Copy failed: ${(e as Error).message}`;
          r.finishedAt = Date.now();
          return r;
        });
        this.store.saveRawJob(id, report.state, report);
        this.live.delete(id);
      }
    } finally {
      this.busy = false;
      this.resolveIdle?.();
    }
  }

  private async run(s: SessionRow): Promise<RawReport> {
    const r = emptyReport('running');
    r.startedAt = Date.now();
    this.live.set(s.id, r);

    if (!this.opts.projectsRoot) {
      r.state = 'failed';
      r.message = 'No projects folder is set up (PROJECTS_PATH in .env).';
      r.finishedAt = Date.now();
      return r;
    }
    if (!(await isWritable(this.opts.projectsRoot))) {
      r.state = 'failed';
      r.message = 'The app cannot write to the projects folder. See “Folder permissions” in the README.';
      r.finishedAt = Date.now();
      return r;
    }

    const clientDir = resolveInside(this.opts.photosRoot, s.folder);
    const hearted = this.store
      .getPicks(s.id)
      .filter((p) => p.selected)
      .map((p) => p.file_name);
    const { matched, missing } = matchRaws(hearted, await indexRaws(clientDir));
    r.missing = missing;
    r.multipleMatches = matched.filter((m) => m.alternatives > 0).map((m) => m.jpeg);
    r.totalFiles = matched.length;
    r.totalBytes = matched.reduce((n, m) => n + m.raw.size, 0);

    const segments = projectSegments(s.folder, s.client_name, this.opts.backupSuffix);
    const dest = await ensureProjectDir(this.opts.projectsRoot, segments);
    r.destination = segments.join('/');
    await cleanPartials(dest);
    this.store.saveRawJob(s.id, 'running', r);

    const seen = new Set<string>();
    for (const m of matched) {
      // Two JPEGs can't share a RAW name in one folder; copy each RAW once.
      const key = m.raw.name.toLowerCase();
      if (seen.has(key)) {
        r.doneFiles++;
        r.doneBytes += m.raw.size;
        continue;
      }
      seen.add(key);
      const out = await copyOne(m.raw.abs, dest, m.raw.name, m.raw.size);
      if (out.status === 'copied') r.copied++;
      else if (out.status === 'exists') r.alreadyThere++;
      else r.problems.push(out.message);
      r.doneFiles++;
      r.doneBytes += m.raw.size;
      if (out.status === 'failed' && /not writable|disk is full/.test(out.message)) {
        r.problems = [out.message];
        r.state = 'failed';
        r.message = out.message;
        r.finishedAt = Date.now();
        return r;
      }
      if (r.doneFiles % 10 === 0) this.store.saveRawJob(s.id, 'running', r);
    }

    r.state = r.problems.length || r.missing.length ? 'done_with_issues' : 'done';
    r.finishedAt = Date.now();
    return r;
  }
}
