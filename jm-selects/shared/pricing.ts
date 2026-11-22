/** Extra-picture pricing, shared by the server and the screens so both always agree. */

export interface Extras {
  selected: number;
  included: number;
  extra: number;
  /** Price per extra picture, whole rand. */
  price: number;
  /** extra × price, whole rand. */
  total: number;
}

export function extrasFor(selected: number, included: number, price: number): Extras {
  const s = Math.max(0, Math.floor(selected));
  const inc = Math.max(0, Math.floor(included));
  const p = Math.max(0, Math.floor(price));
  const extra = Math.max(0, s - inc);
  return { selected: s, included: inc, extra, price: p, total: extra * p };
}

/** South African rand, whole amounts: 1250 → "R1,250", 0 → "R0". */
export function formatRand(amount: number): string {
  const n = Math.round(amount);
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}R${digits}`;
}

/** Parse a staff-entered price ("250", "R1,250", " 300 "). Returns null if not a whole amount 0–100000. */
export function parsePrice(input: unknown): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input >= 0 && input <= 100000 ? input : null;
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/^r\s*/i, '').replace(/[,\s]/g, '');
  if (!/^\d{1,6}$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return n <= 100000 ? n : null;
}
