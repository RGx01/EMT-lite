// The bill card's arithmetic (design §7): one pure function over the indexed intervals.
// Money is PENCE. Import energy and standing charge carry VAT from the calendar; export
// payments carry none.
//
// Rounding is EMT's Bill Rounding (energy_charts._bill_method_breakdown, bill_card.bill_total),
// which is how Octopus builds a bill: every half-hour's ex-VAT cost is summed UNROUNDED, and only
// the bill's lines are rounded to the penny, once each (billMethod below).

import { daysBetween, slotsOfDay, dayKeyOf, slotOf, instantsOf, repeatedSlots, HALF_HOUR } from './time.js';
import { vatRate } from './vat.js';

/**
 * What one half-hour is, for the heatmap and the bill's gap count:
 *   'present'  — Octopus has a reading
 *   'partial'  — the clocks-back day's repeated half-hour, with one of its two readings missing:
 *                what is there counts, and the other is missing
 *   'missing'  — it should have one and does not (hatched)
 *   'pending'  — after Octopus's latest reading: not in yet, not missing
 *   'outside'  — before the supply started on this meter
 *   'future'   — has not happened yet
 * `cover` = { from: day key the supply started, last: ms of the latest reading or null,
 *             now: ms (defaults to the clock) }.
 */
export function slotState(days, dayKey, slot, cover) {
  const now = cover.now ?? Date.now();
  const iv = days.get(dayKey)?.get(slot);
  if (iv) {
    // A repeated clocks-back half-hour is two readings; one absent, finished and not merely late
    // (at or before the latest reading, after the supply began) is missing.
    if (iv.starts && repeatedSlots(dayKey).has(slot)) {
      const inst = instantsOf(dayKey, slot);
      const gone = inst.filter((t) => !iv.starts.includes(t) && t + HALF_HOUR <= now
        && cover.last != null && t <= cover.last && !(cover.from && dayKeyOf(t) < cover.from));
      if (gone.length) return 'partial';
    }
    return 'present';
  }
  const today = dayKeyOf(now);
  // the half-hour in progress has not finished: it is future too
  if (dayKey > today || (dayKey === today && slot >= slotOf(now))) return 'future';
  if (cover.from && dayKey < cover.from) return 'outside';
  if (cover.last == null) return 'pending';
  const lastDay = dayKeyOf(cover.last);
  if (dayKey > lastDay || (dayKey === lastDay && slot > slotOf(cover.last))) return 'pending';
  return 'missing';
}

function emptyBand() { return { kwh: 0, cost: 0, exc: 0 }; }

/**
 * Summarise [period.start, period.end). `imp` / `exp` are byDay() maps (exp may be null);
 * `impCover` / `expCover` as slotState's `cover`.
 */
export function summarise(period, imp, impCover, exp = null, expCover = null, vat = vatRate) {
  const s = {
    days: 0, finished: dayKeyOf(impCover.now ?? Date.now()) >= period.end, kwh: 0, energy: 0, standing: 0, total: 0,
    offPeak: emptyBand(), peak: emptyBand(), unbanded: emptyBand(),
    uncostedKwh: 0, uncostedSlots: 0, missing: 0, pending: 0,
    exportKwh: 0, exportCredit: 0, exportMissing: 0, net: 0, avgRate: null,
    split: null, unsplitSlots: 0,   // Octopus's House/EV split (IOG-SMB), VAT added; costed half-hours without one
    energyExc: 0, standingDays: {},  // ex VAT, unrounded; local day → { exc, vat } of its standing charge
    vatByDay: {},                    // local day → VAT rate in force (for the VAT line's label)
    bill: null,                      // the bill's lines, rounded as Octopus rounds them (billMethod)
  };
  let costedKwh = 0;
  const today = dayKeyOf(impCover.now ?? Date.now());
  for (const k of daysBetween(period.start, period.end)) {
    if (k > today) break;
    s.days++;
    const v = 1 + vat(k);
    s.vatByDay[k] = vat(k);
    const day = imp.get(k);
    for (const slot of slotsOfDay(k)) {
      const st = slotState(imp, k, slot, impCover);
      if (st === 'missing' || st === 'partial') s.missing++;
      if (st === 'pending') s.pending++;
      if (st !== 'present' && st !== 'partial') continue;
      const iv = day.get(slot);
      s.kwh += iv.kwh;
      if (iv.standingExc != null) {
        s.standing += iv.standingExc * v;
        const sd = s.standingDays[k] || (s.standingDays[k] = { exc: 0, vat: v - 1 });
        sd.exc += iv.standingExc;
      }
      if (iv.costExc == null) {
        if (iv.kwh > 0) { s.uncostedKwh += iv.kwh; s.uncostedSlots++; }
        continue;
      }
      const cost = iv.costExc * v;
      s.energy += cost;
      s.energyExc += iv.costExc;
      costedKwh += iv.kwh;
      const band = iv.offPeak === true ? s.offPeak : iv.offPeak === false ? s.peak : s.unbanded;
      band.kwh += iv.kwh;
      band.cost += cost;
      band.exc += iv.costExc;
      if (iv.split) {
        s.split = s.split || {};
        for (const [key, e] of Object.entries(iv.split)) {
          const t = s.split[key] || (s.split[key] = { kwh: 0, cost: 0, exc: 0 });
          t.kwh += e.kwh;
          t.cost += e.cost * v;
          t.exc += e.cost;
        }
      } else {
        s.unsplitSlots++;
      }
    }
    if (exp) {
      const eday = exp.get(k);
      for (const slot of slotsOfDay(k)) {
        const st = slotState(exp, k, slot, expCover);
        if (st === 'missing' || st === 'partial') s.exportMissing++;
        if (st !== 'present' && st !== 'partial') continue;
        const iv = eday.get(slot);
        s.exportKwh += iv.kwh;
        if (iv.costExc != null) s.exportCredit += Math.abs(iv.costExc);
      }
    }
  }
  if (!s.split) s.unsplitSlots = 0;        // not a split tariff: nothing is waiting for one
  s.total = s.energy + s.standing;
  s.net = s.total - s.exportCredit;
  s.avgRate = costedKwh > 0 ? s.energy / costedKwh : null;
  s.bill = billMethod(s);
  return s;
}

/** Round pence to a whole penny, half to even, as EMT's Python `round(x, 2)` on pounds does. */
export function penny(p) {
  const f = Math.floor(p), d = p - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(p);
}

/**
 * The bill's lines from a summary's unrounded sums, as EMT's Bill Rounding builds them:
 *   energyExc    Σ every half-hour's ex-VAT cost, rounded once
 *   standing     one line per distinct ex-VAT daily rate: { days, rateExc, exc } (exc rounded)
 *   standingExc  Σ the days' ex-VAT standing charge, rounded once
 *   subtotalExc  energy + standing ex VAT, rounded once
 *   vat          (inc − ex) over the period, rounded once; vatLabel names each rate in force
 *   incTotal     energy + standing inc VAT, rounded once ("Total incl. VAT")
 *   exportCredit the export payments, rounded once (as printed)
 *   total        incTotal − exportCredit: the bill
 * Each line is rounded on its own, as on a bill, so energy + standing + VAT can differ from
 * incTotal by a penny; the total is always the two lines above it.
 */
export function billMethod(s) {
  const days = Object.keys(s.standingDays).sort();
  const standingExcRaw = days.reduce((a, d) => a + s.standingDays[d].exc, 0);
  const byRate = new Map();
  for (const d of days) {
    const { exc } = s.standingDays[d];
    const k = exc.toFixed(6);
    const g = byRate.get(k) || { days: 0, rateExc: exc, exc: 0 };
    g.days++; g.exc += exc;
    byRate.set(k, g);
  }
  const standing = [...byRate.values()].sort((a, b) => a.rateExc - b.rateExc)
    .map((g) => ({ days: g.days, rateExc: g.rateExc, exc: penny(g.exc) }));
  const subtotalRaw = s.energyExc + standingExcRaw;
  const incRaw = s.energy + s.standing;
  const incTotal = penny(incRaw), exportCredit = penny(s.exportCredit);
  return {
    energyExc: penny(s.energyExc),
    standing,
    standingDays: days.length,
    standingExc: penny(standingExcRaw),
    subtotalExc: penny(subtotalRaw),
    vat: penny(incRaw - subtotalRaw),
    vatLabel: vatLabel(s.vatByDay),
    incTotal,
    exportCredit,
    total: incTotal - exportCredit,
  };
}

const SHORT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (k) => `${Number(k.slice(8))} ${SHORT_MON[Number(k.slice(5, 7)) - 1]}`;
const pct = (r) => `${+(r * 100).toFixed(1)}%`;

/** "VAT @ 5%", or each rate in force with its dates: "VAT @ 5% to 30 Sep, 0% from 1 Oct". */
export function vatLabel(vatByDay) {
  const spans = [];
  for (const d of Object.keys(vatByDay).sort()) {
    const v = vatByDay[d];
    if (spans.length && spans[spans.length - 1].v === v) spans[spans.length - 1].to = d;
    else spans.push({ v, from: d, to: d });
  }
  if (spans.length <= 1) return `VAT @ ${pct(spans[0]?.v ?? 0)}`;
  return `VAT @ ${spans.map((sp, i) => `${pct(sp.v)} ${i === 0 ? `to ${shortDay(sp.to)}`
    : i === spans.length - 1 ? `from ${shortDay(sp.from)}` : `${shortDay(sp.from)}–${shortDay(sp.to)}`}`).join(', ')}`;
}

/** Pence as pounds; a credit reads −£5.67, not £-5.67. */
export const pounds = (pence) => `${pence < -0.004 ? '−' : ''}£${(Math.abs(pence) / 100).toFixed(2)}`;
