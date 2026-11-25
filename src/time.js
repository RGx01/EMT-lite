// UK local time, without a date library. Every date the page shows or cuts periods by is a
// Europe/London calendar date, as `YYYY-MM-DD` (a "day key"). Instants are UTC milliseconds.

export const TZ = 'Europe/London';
export const HALF_HOUR = 30 * 60 * 1000;

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

const pad = (n) => String(n).padStart(2, '0');

/** Local wall-clock parts of a UTC instant. */
export function localParts(ms) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute };
}

export function dayKeyOf(ms) {
  const p = localParts(ms);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

export function key(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

export function parseKey(k) {
  const [y, m, d] = k.split('-').map(Number);
  return { y, m, d };
}

/** Minutes local time is ahead of UTC at instant `ms` (0 in GMT, 60 in BST). */
export function offsetMinutes(ms) {
  const p = localParts(ms);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
  return Math.round((asUtc - Math.floor(ms / 60000) * 60000) / 60000);
}

/** The UTC instant of local midnight starting day key `k`. UK clocks never change at midnight. */
export function midnight(k) {
  const { y, m, d } = parseKey(k);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMinutes(guess) * 60000;
  t = guess - offsetMinutes(t) * 60000;
  return t;
}

export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export function addDays(k, n) {
  const { y, m, d } = parseKey(k);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return key(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** `n` months on from (y, m), keeping `day` but clamping it to the month's length. */
export function addMonths(y, m, day, n) {
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  return key(ny, nm, Math.min(day, daysInMonth(ny, nm)));
}

/** Local half-hour slot 0..47 of an instant. The repeated clocks-back hour maps twice onto the
 *  same slots (the caller sums them); the clocks-forward hour's slots never occur. */
export function slotOf(ms) {
  const p = localParts(ms);
  return p.hh * 2 + (p.mm >= 30 ? 1 : 0);
}

const _slotsCache = new Map();
/** The set of local slots that exist on day `k` (48 on most days, 46 when the clocks go forward). */
export function slotsOfDay(k) {
  let s = _slotsCache.get(k);
  if (s) return s;
  s = new Set();
  const end = midnight(addDays(k, 1));
  for (let t = midnight(k); t < end; t += HALF_HOUR) s.add(slotOf(t));
  _slotsCache.set(k, s);
  return s;
}

/** Every day key from `a` to `b`, `b` excluded. */
export function daysBetween(a, b) {
  const out = [];
  for (let k = a; k < b; k = addDays(k, 1)) out.push(k);
  return out;
}

/** An ISO string with the local offset, as Octopus's `startAt` / `endAt` want. */
export function isoLocal(ms) {
  const p = localParts(ms), off = offsetMinutes(ms);
  const sign = off >= 0 ? '+' : '-', a = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function todayKey(now = Date.now()) { return dayKeyOf(now); }
