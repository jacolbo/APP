import { naturalCompare } from './photos.js';
import { formatRand, type Extras } from '../shared/pricing.js';

export interface PickLike {
  file_name: string;
  selected: number | boolean;
  stars: number;
}

export interface CopyListOptions {
  /** 'hearted' = selected with the heart; 'stars' = rated at least minStars. */
  filter: 'hearted' | 'stars';
  minStars?: number;
  includeExtension: boolean;
  /** ',' (default) or ', ' */
  separator?: ',' | ', ';
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Build the comma-separated file-name list pasted into Capture One.
 * Only names that still exist in the folder are included (pass `existing`).
 */
export function buildCopyList(picks: PickLike[], opts: CopyListOptions, existing?: Set<string>): string {
  const min = Math.min(5, Math.max(1, opts.minStars ?? 1));
  const chosen = picks
    .filter((p) => (existing ? existing.has(p.file_name) : true))
    .filter((p) => (opts.filter === 'hearted' ? Boolean(p.selected) : p.stars >= min))
    .map((p) => p.file_name)
    .sort(naturalCompare)
    .map((n) => (opts.includeExtension ? n : stripExtension(n)));
  // De-duplicate case-insensitively (e.g. IMG_1.jpg + IMG_1.JPEG without extension).
  const seen = new Set<string>();
  const unique = chosen.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.join(opts.separator ?? ',');
}

function csvCell(value: string): string {
  // Quote, and neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * CSV export: a short summary (client, included, extra, extra total) then one row per photo.
 */
export function buildCsv(fileNames: string[], picks: PickLike[], summary?: Extras & { clientName: string }): string {
  const byName = new Map(picks.map((p) => [p.file_name, p]));
  const lines: string[] = [];
  if (summary) {
    lines.push(
      `"Client",${csvCell(summary.clientName)}`,
      `"Selected","${summary.selected}"`,
      `"Included in package","${summary.included}"`,
      `"Extra pictures","${summary.extra}"`,
      `"Price per extra picture","${formatRand(summary.price)}"`,
      `"Extra total","${formatRand(summary.total)}"`,
      '',
    );
  }
  lines.push('"File name","Selected","Stars"');
  for (const name of [...fileNames].sort(naturalCompare)) {
    const p = byName.get(name);
    lines.push([csvCell(name), p?.selected ? '"yes"' : '"no"', `"${p?.stars ?? 0}"`].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
