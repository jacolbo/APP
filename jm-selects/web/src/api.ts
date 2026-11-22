import type { Extras } from '../../shared/pricing';
export type { Extras };

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string }).error ?? `Error ${res.status}`, data as Record<string, unknown>);
  }
  return data as T;
}

export interface Photo {
  name: string;
  v: string;
}
export interface Pick {
  selected: boolean;
  stars: number;
}
export interface ClientData {
  clientName: string;
  packageSize: number;
  extraPrice: number;
  status: 'in_progress' | 'done';
  photos: Photo[];
  picks: Record<string, Pick>;
}
export interface Session {
  id: number;
  token: string;
  clientName: string;
  folder: string;
  packageSize: number;
  extraPrice: number;
  status: 'in_progress' | 'done';
  createdAt: number;
  updatedAt: number;
  doneAt: number | null;
  selectedCount?: number;
  ratedCount?: number;
  rawState?: RawState | null;
  extras?: Extras;
}

export type RawState = 'queued' | 'running' | 'done' | 'done_with_issues' | 'failed' | 'interrupted';
export interface RawStatus {
  enabled: boolean;
  projectsLabel: string;
  state: RawState | null;
  destination?: string | null;
  totalFiles?: number;
  doneFiles?: number;
  copied?: number;
  alreadyThere?: number;
  totalBytes?: number;
  doneBytes?: number;
  missing?: string[];
  problems?: string[];
  multipleMatches?: string[];
  startedAt?: number | null;
  finishedAt?: number | null;
  message?: string | null;
}

export const imgUrl = (token: string, variant: 'thumb' | 'preview', p: Photo) =>
  `/img/c/${token}/${variant}/${encodeURIComponent(p.name)}?v=${p.v}`;

/** Copy text. Works on plain-http studio addresses where navigator.clipboard is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

const CLIENT_KEY = 'jm-selects-client-token';
export const rememberClient = (token: string | null) => {
  try {
    if (token) localStorage.setItem(CLIENT_KEY, token);
    else localStorage.removeItem(CLIENT_KEY);
  } catch {
    /* private mode */
  }
};
export const rememberedClient = (): string | null => {
  try {
    return localStorage.getItem(CLIENT_KEY);
  } catch {
    return null;
  }
};
