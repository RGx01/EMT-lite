// The bill card's arithmetic (design §7): one pure function over the indexed intervals.
// Money is PENCE. Import energy and standing charge carry VAT from the calendar; export
// payments carry none.
//
// Rounding is EMT's Bill Rounding (energy_charts._bill_method_breakdown, bill_card.bill_total),
// which is how Octopus builds a bill: every half-hour's ex-VAT cost is summed UNROUNDED, and only
// the bill's lines are rounded to the penny, once each (billMethod below).

import { daysBetween, slotsOfDay, dayKeyOf, slotOf, instantsOf, repeatedSlots, HALF_HOUR, midnight, addDays } from './time.js';
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

/** A half-hour's kWh as an Agile statement prints and prices it: to 0.01 kWh, half to even
 *  (0.005 → 0.00, 0.015 → 0.02, 1.945 → 1.94). EMT's statement_kwh (26 Nov 2026). */
export function statementKwh(kwh) {
  const x = Math.round((Number(kwh) || 0) * 1e6) / 1e6;   // a sum's 0.0050000000001 is 0.005
  const h = Math.round(x * 1e6) / 1e4;                      // hundredths, exact to the meter's 0.001
  const f = Math.floor(h);
  const n = Math.abs(h - f - 0.5) < 1e-6 ? (f % 2 === 0 ? f : f + 1) : Math.round(h);
  return n / 100 + 0;                                       // + 0: never −0
}

/** A half-hour on an Agile statement: each reading at its rate × its kWh to 0.01 (statementKwh).
 *  `costExc` is the half-hour's whole cost, Octopus's or estimated; a reading without its own cost
 *  takes its share of it. `onAgile(ms)` says which readings are on Agile; others keep theirs.
 *  Returns { kwh, exc }. */
export function statementOf(iv, costExc, onAgile) {
  const parts = iv.parts || [{ start: iv.start, kwh: iv.kwh, costExc: iv.costExc }];
  let kwh = 0, exc = 0;
  for (const p of parts) {
    const c = p.costExc ?? (iv.kwh > 0 ? costExc * p.kwh / iv.kwh : 0);
    if (!onAgile(p.start) || !(p.kwh > 0)) { kwh += p.kwh; exc += c; continue; }
    const k2 = statementKwh(p.kwh);
    kwh += k2;
    exc += c * k2 / p.kwh;          // Octopus's cost is the rate × the meter's kWh
  }
  return { kwh, exc };
}

function emptyBand() { return { kwh: 0, cost: 0, exc: 0 }; }

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

/** How many half-hours day `k` has: 48, or 46 / 50 when the clocks change. */
function halfHoursOf(k) {
  return Math.round((midnight(addDays(k, 1)) - midnight(k)) / HALF_HOUR);
}

/**
 * Summarise [period.start, period.end). `imp` / `exp` are byDay() maps (exp may be null);
 * `impCover` / `expCover` as slotState's `cover`. `opts`:
 *   standingRate(dayKey)  the tariff's daily standing charge ex VAT, pence, or null
 *   offWindowOn(dayKey)   the tariff's fixed off-peak window (slot → bool), or null
 *   agileImport(ms), agileExport(ms)   whether the import / export agreement at that instant is
 *                         Agile (Agile Outgoing): its statement prices each half-hour at its kWh
 *                         to 0.01 (statementOf). Null or absent: no Agile.
 * `kwh` and `exportKwh` stay the meter's; `billKwh` and `billExportKwh` are the statement's, and the
 * bands, costs and credit follow the statement.
 */
export function summarise(period, imp, impCover, exp = null, expCover = null, vat = vatRate, opts = {}) {
  const s = {
    days: 0, finished: dayKeyOf(impCover.now ?? Date.now()) >= period.end, kwh: 0, energy: 0, standing: 0, total: 0,
    offPeak: emptyBand(), peak: emptyBand(), unbanded: emptyBand(),
    uncostedKwh: 0, uncostedSlots: 0, missing: 0, pending: 0,
    estimatedKwh: 0, estimatedSlots: 0,  // half-hours Octopus never costed, priced at their band's rate
    exportKwh: 0, exportCredit: 0, exportMissing: 0, net: 0, avgRate: null,
    billKwh: 0, billExportKwh: 0,    // as the statement prices them: on Agile, each half-hour to 0.01 kWh
    agileSlots: 0,                   // half-hours priced at the Agile statement's kWh, import and export
    split: null, unsplitSlots: 0,   // Octopus's House/EV split (IOG-SMB), VAT added; costed half-hours without one
    energyExc: 0, standingDays: {},  // ex VAT, unrounded; local day → { exc, vat } of its standing charge
    vatByDay: {},                    // local day → VAT rate in force (for the VAT line's label)
    bill: null,                      // the bill's lines, rounded as Octopus rounds them (billMethod)
  };
  let costedKwh = 0;
  const today = dayKeyOf(impCover.now ?? Date.now());
  const rates = bandRates(period, imp, today);
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
        const sd = s.standingDays[k] || (s.standingDays[k] = { exc: 0, vat: v - 1, n: 0 });
        sd.exc += iv.standingExc;
        sd.n += iv.starts?.length || 1;
      }
      let costExc = iv.costExc, offPeak = iv.offPeak, estimated = false;
      if (costExc == null) {
        if (!(iv.kwh > 0)) continue;
        // Octopus never costed it, even after the day / month / noon-to-noon retries: price it at
        // its band's rate that day (else the period's). The band: Octopus's label; else the band
        // Octopus charged most at this time of day in the period (charging often runs past 05:30);
        // else the tariff's fixed window. With nothing to go by, it stays uncosted.
        const win = opts.offWindowOn?.(k);
        const b = offPeak ?? rates.bandAt(slot) ?? (win ? win(slot) : null);
        const r = rates.rateFor(k, b);
        if (r == null) { s.uncostedKwh += iv.kwh; s.uncostedSlots++; s.billKwh += iv.kwh; continue; }
        costExc = iv.kwh * r;
        offPeak = b;
        estimated = true;
        s.estimatedKwh += iv.kwh;
        s.estimatedSlots++;
      }
      let billKwh = iv.kwh;
      if (opts.agileImport && (iv.parts || [iv]).some((p) => opts.agileImport(p.start))) {
        ({ kwh: billKwh, exc: costExc } = statementOf(iv, costExc, opts.agileImport));
        s.agileSlots++;
      }
      s.billKwh += billKwh;
      const cost = costExc * v;
      s.energy += cost;
      s.energyExc += costExc;
      costedKwh += billKwh;
      const band = offPeak === true ? s.offPeak : offPeak === false ? s.peak : s.unbanded;
      band.kwh += billKwh;
      band.cost += cost;
      band.exc += costExc;
      if (estimated) continue;            // no split to give it: Octopus has not costed it
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
        let k2 = iv.kwh, credit = iv.costExc != null ? Math.abs(iv.costExc) : null;
        if (opts.agileExport && credit != null && (iv.parts || [iv]).some((p) => opts.agileExport(p.start))) {
          // a credit, so each reading's cost is taken as a positive amount
          const parts = (iv.parts || [{ start: iv.start, kwh: iv.kwh, costExc: iv.costExc }])
            .map((q) => ({ ...q, costExc: q.costExc == null ? null : Math.abs(q.costExc) }));
          ({ kwh: k2, exc: credit } = statementOf({ ...iv, parts }, credit, opts.agileExport));
          s.agileSlots++;
        }
        s.billExportKwh += k2;
        if (credit != null) s.exportCredit += credit;
      }
    }
  }
  if (!s.split) s.unsplitSlots = 0;        // not a split tariff: nothing is waiting for one
  // The standing charge is a DAILY charge; Octopus spreads it over the half-hours, rounding each
  // share (1.04p of a 50.05p day). A finished day with only some half-hours carrying it is scaled
  // to the whole day; a day within rounding of the tariff's daily rate is that rate. A real price
  // change (far from the tariff's current figure) keeps the half-hours' sum.
  for (const [k, sd] of Object.entries(s.standingDays)) {
    const all = halfHoursOf(k);
    if (k < today && sd.n > 0 && sd.n < all) sd.exc = sd.exc * all / sd.n;
    const rate = Number(opts.standingRate?.(k));
    if (k < today && rate > 0 && Math.abs(sd.exc - rate) <= all * 0.005 + 1e-9) sd.exc = rate;
    s.standing += sd.exc * (1 + sd.vat);
  }
  s.total = s.energy + s.standing;
  s.net = s.total - s.exportCredit;
  s.avgRate = costedKwh > 0 ? s.energy / costedKwh : null;
  s.bill = billMethod(s);
  return s;
}

/** The period's charged rates (pence/kWh ex VAT), by day and band, from the half-hours Octopus
 *  costed: what an uncosted half-hour is estimated at. `rateFor(k, band)`: that day's median for
 *  the band, else the period's; with no band, the day's (else period's) rate only if it charged
 *  a single one. */
function bandRates(period, imp, today) {
  const days = new Map(), all = { true: [], false: [], any: [] };
  const atSlot = new Map();             // slot → [off-peak count, peak count], half-hours that drew power
  for (const k of daysBetween(period.start, period.end)) {
    if (k > today) break;
    const d = { true: [], false: [], any: [] };
    for (const iv of imp.get(k)?.values() || []) {
      if (iv.costExc == null || !(iv.kwh > 0.0005)) continue;
      const r = iv.costExc / iv.kwh;
      d.any.push(r); all.any.push(r);
      if (iv.offPeak === true || iv.offPeak === false) {
        d[iv.offPeak].push(r); all[iv.offPeak].push(r);
        if (iv.kwh > 0.05) {
          const slot = slotOf(iv.start), c = atSlot.get(slot) || [0, 0];
          c[iv.offPeak ? 0 : 1]++;
          atSlot.set(slot, c);
        }
      }
    }
    days.set(k, d);
  }
  const single = (xs) => (xs.length && new Set(xs.map((r) => r.toFixed(2))).size === 1 ? xs[0] : null);
  return {
    /** The band Octopus charged most at this time of day (at least 3 half-hours, a clear
     *  majority), or null. */
    bandAt(slot) {
      const [off, peak] = atSlot.get(slot) || [0, 0];
      if (off + peak < 3) return null;
      if (off >= 2 * peak) return true;
      if (peak >= 2 * off) return false;
      return null;
    },
    rateFor(k, band) {
      const d = days.get(k) || { true: [], false: [], any: [] };
      if (band === true || band === false) return median(d[band]) ?? median(all[band]);
      return single(d.any) ?? single(all.any);
    },
  };
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
