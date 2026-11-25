// The bill card's arithmetic (design §7): one pure function over the indexed intervals.
// Money is PENCE. Import energy and standing charge carry VAT from the calendar; export
// payments carry none.

import { daysBetween, slotsOfDay, dayKeyOf, slotOf } from './time.js';
import { vatRate } from './vat.js';

/**
 * What one half-hour is, for the heatmap and the bill's gap count:
 *   'present'  — Octopus has a reading
 *   'missing'  — it should have one and does not (hatched)
 *   'pending'  — after Octopus's latest reading: not in yet, not missing
 *   'outside'  — before the supply started on this meter
 *   'future'   — has not happened yet
 * `cover` = { from: day key the supply started, last: ms of the latest reading or null,
 *             now: ms (defaults to the clock) }.
 */
export function slotState(days, dayKey, slot, cover) {
  if (days.get(dayKey)?.has(slot)) return 'present';
  const now = cover.now ?? Date.now(), today = dayKeyOf(now);
  if (dayKey > today || (dayKey === today && slot > slotOf(now))) return 'future';
  if (cover.from && dayKey < cover.from) return 'outside';
  if (cover.last == null) return 'pending';
  const lastDay = dayKeyOf(cover.last);
  if (dayKey > lastDay || (dayKey === lastDay && slot > slotOf(cover.last))) return 'pending';
  return 'missing';
}

function emptyBand() { return { kwh: 0, cost: 0 }; }

/**
 * Summarise [period.start, period.end). `imp` / `exp` are byDay() maps (exp may be null);
 * `impCover` / `expCover` as slotState's `cover`.
 */
export function summarise(period, imp, impCover, exp = null, expCover = null) {
  const s = {
    days: 0, finished: dayKeyOf(impCover.now ?? Date.now()) >= period.end, kwh: 0, energy: 0, standing: 0, total: 0,
    offPeak: emptyBand(), peak: emptyBand(), unbanded: emptyBand(),
    uncostedKwh: 0, uncostedSlots: 0, missing: 0, pending: 0,
    exportKwh: 0, exportCredit: 0, exportMissing: 0, net: 0, avgRate: null,
  };
  let costedKwh = 0;
  const today = dayKeyOf(impCover.now ?? Date.now());
  for (const k of daysBetween(period.start, period.end)) {
    if (k > today) break;
    s.days++;
    const v = 1 + vatRate(k);
    const day = imp.get(k);
    for (const slot of slotsOfDay(k)) {
      const st = slotState(imp, k, slot, impCover);
      if (st === 'missing') s.missing++;
      if (st === 'pending') s.pending++;
      if (st !== 'present') continue;
      const iv = day.get(slot);
      s.kwh += iv.kwh;
      if (iv.standingExc != null) s.standing += iv.standingExc * v;
      if (iv.costExc == null) {
        if (iv.kwh > 0) { s.uncostedKwh += iv.kwh; s.uncostedSlots++; }
        continue;
      }
      const cost = iv.costExc * v;
      s.energy += cost;
      costedKwh += iv.kwh;
      const band = iv.offPeak === true ? s.offPeak : iv.offPeak === false ? s.peak : s.unbanded;
      band.kwh += iv.kwh;
      band.cost += cost;
    }
    if (exp) {
      const eday = exp.get(k);
      for (const slot of slotsOfDay(k)) {
        const st = slotState(exp, k, slot, expCover);
        if (st === 'missing') s.exportMissing++;
        if (st !== 'present') continue;
        const iv = eday.get(slot);
        s.exportKwh += iv.kwh;
        if (iv.costExc != null) s.exportCredit += Math.abs(iv.costExc);
      }
    }
  }
  s.total = s.energy + s.standing;
  s.net = s.total - s.exportCredit;
  s.avgRate = costedKwh > 0 ? s.energy / costedKwh : null;
  return s;
}

export const pounds = (pence) => `£${(pence / 100).toFixed(2)}`;
