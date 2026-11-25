// Period cutting (design §5.2). Periods are [start, end) local day keys.

import { addMonths, parseKey, daysInMonth, key, addDays } from './time.js';

/**
 * Bill periods covering [firstKey, lastKey]. `anchor` is a day key a bill period starts on
 * (Octopus's currentBillingPeriodStartDate, or one built from the billing day). Periods step
 * `months` months (1 monthly, 3 quarterly, × Octopus's multiplier) back and forth from it,
 * keeping the anchor's day of the month, clamped to short months (EMT's billing.py rule).
 */
export function billPeriods(anchor, months, firstKey, lastKey) {
  const { y, m, d } = parseKey(anchor);
  const startAt = (i) => addMonths(y, m, d, i * months);
  let i = 0;
  while (startAt(i) > firstKey) i--;
  const out = [];
  for (; startAt(i) <= lastKey; i++) out.push({ start: startAt(i), end: startAt(i + 1) });
  return out;
}

/** The start of the monthly bill period holding `today`, from a billing day of the month. */
export function anchorFromBillingDay(billingDay, today) {
  const { y, m, d } = parseKey(today);
  const bd = Math.max(1, Math.min(31, Number(billingDay) || 1));
  if (d >= Math.min(bd, daysInMonth(y, m))) return key(y, m, Math.min(bd, daysInMonth(y, m)));
  return addMonths(y, m, bd, -1);
}

/** Calendar months, quarters or years covering [firstKey, lastKey]. */
export function calendarPeriods(kind, firstKey, lastKey) {
  const { y, m } = parseKey(firstKey);
  let start;
  let step;
  if (kind === 'month') { start = key(y, m, 1); step = 1; }
  else if (kind === 'quarter') { start = key(y, Math.floor((m - 1) / 3) * 3 + 1, 1); step = 3; }
  else if (kind === 'year') { start = key(y, 1, 1); step = 12; }
  else throw new Error(`unknown period kind ${kind}`);
  const out = [];
  while (start <= lastKey) {
    const s = parseKey(start);
    const end = addMonths(s.y, s.m, 1, step);
    out.push({ start, end });
    start = end;
  }
  return out;
}

/** EMT's comparison rules: the period just before; and the one whose start is closest to a year
 *  earlier, within 36 days. `list` is ordered oldest first. */
export function previousOf(list, p) {
  const i = list.findIndex((q) => q.start === p.start);
  return i > 0 ? list[i - 1] : null;
}

export function lastYearOf(list, p) {
  const { y, m, d } = parseKey(p.start);
  const target = Date.UTC(y - 1, m - 1, d);
  let best = null, bestGap = Infinity;
  for (const q of list) {
    const s = parseKey(q.start);
    const gap = Math.abs(Date.UTC(s.y, s.m - 1, s.d) - target) / 86400000;
    if (gap <= 36 && gap < bestGap) { best = q; bestGap = gap; }
  }
  return best;
}

export function periodLabel(p, kind) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const s = parseKey(p.start);
  if (kind === 'month') return `${MON[s.m - 1]} ${s.y}`;
  if (kind === 'quarter') return `Q${Math.floor((s.m - 1) / 3) + 1} ${s.y}`;
  if (kind === 'year') return String(s.y);
  const e = parseKey(addDays(p.end, -1));
  const f = (x) => `${x.d} ${MON[x.m - 1]} ${x.y}`;
  return `${f(s)} – ${f(e)}`;
}

