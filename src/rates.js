// The day chart's rate line (design §5.5): what Octopus charged each half-hour, p/kWh with VAT.

import { vatRate } from './vat.js';

const MIN_KWH = 0.0005;   // below this, cost ÷ kWh is noise

function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : null;
}

/**
 * `day`: Map<slot, interval> for one local day. `slots`: that day's slots in order.
 * `published`: Map<slot, p/kWh exc VAT> (Agile's public rates), or null.
 * Returns Map<slot, p/kWh inc VAT | null>.
 *
 *  1. kWh and a cost: costExc ÷ kWh.
 *  2. Otherwise a published rate for the slot (Agile).
 *  3. Otherwise the day's charged rate for the same Octopus band; a slot with no band takes the
 *     day's rate only when the day charged a single rate (a flat tariff).
 *  4. Otherwise null: a gap in the line.
 */
export function rateLine(dayKey, day, slots, published = null) {
  const v = 1 + vatRate(dayKey);
  const out = new Map();
  const byBand = { true: [], false: [], all: [] };
  for (const slot of slots) {
    const iv = day?.get(slot);
    if (iv && iv.costExc != null && iv.kwh > MIN_KWH) {
      const r = iv.costExc / iv.kwh;
      out.set(slot, r * v);
      byBand.all.push(r);
      if (iv.offPeak === true || iv.offPeak === false) byBand[iv.offPeak].push(r);
    }
  }
  const distinct = new Set(byBand.all.map((r) => r.toFixed(2)));
  for (const slot of slots) {
    if (out.has(slot)) continue;
    const pub = published?.get(slot);
    if (pub != null) { out.set(slot, pub * v); continue; }
    const iv = day?.get(slot);
    let r = null;
    if (iv && (iv.offPeak === true || iv.offPeak === false)) r = median(byBand[iv.offPeak]);
    else if (distinct.size === 1) r = byBand.all[0];
    out.set(slot, r == null ? null : r * v);
  }
  return out;
}

/** Fill a rate map's gaps so the line is continuous: each gap takes the rate before it, and a
 *  leading gap the first rate after it. A day with no rate at all stays empty. */
export function solid(rates, slots) {
  const out = new Map();
  let last = null;
  for (const s of slots) {
    const r = rates.get(s);
    if (r != null) last = r;
    out.set(s, last);
  }
  const first = slots.map((s) => out.get(s)).find((r) => r != null) ?? null;
  for (const s of slots) if (out.get(s) == null) out.set(s, first);
  return out;
}

// Intelligent Octopus's fixed off-peak window, 23:30–05:30 local: slots 47 and 0–10.
export const inIogWindow = (slot) => slot >= 47 || slot <= 10;

/**
 * The rate one side of Octopus's IOG-SMB split was charged (design §5.5), p/kWh with VAT:
 * that side's bucket cost ÷ its kWh. Where the side drew nothing, the half-hour's band decides:
 * off-peak if any bucket in it carries off-peak (a dispatch), else off-peak inside IOG's
 * 23:30–05:30 window, else peak. The rate is then the side's own rate for that band that day, or
 * the other side's. Not carried on from the half-hour before: after a dispatch ends, a house that
 * draws nothing is back at peak.
 */
export function sideRateLine(dayKey, day, slots, side) {
  const v = 1 + vatRate(dayKey);
  const other = side === 'ev' ? 'home' : 'ev';
  const raw = new Map();
  const byBand = { ev: { off: [], peak: [], other: [] }, home: { off: [], peak: [], other: [] } };
  const offInSlot = new Set();
  for (const s of slots) {
    const sp = day?.get(s)?.split;
    if (!sp) continue;
    for (const sd of ['ev', 'home']) {
      let k = 0, c = 0;
      for (const band of ['off', 'peak', 'other']) {
        const e = sp[`${sd}:${band}`];
        if (e && e.kwh > MIN_KWH) {
          byBand[sd][band].push(e.cost / e.kwh);
          k += e.kwh; c += e.cost;
          if (band === 'off') offInSlot.add(s);
        }
      }
      if (sd === side && k > MIN_KWH) raw.set(s, c / k);
    }
  }
  const out = new Map();
  for (const s of slots) {
    let r = raw.get(s) ?? null;
    if (r == null) {
      const b = offInSlot.has(s) || inIogWindow(s) ? 'off' : 'peak';
      r = median(byBand[side][b]) ?? median(byBand[other][b]);
    }
    out.set(s, r == null ? null : r * v);
  }
  return solid(out, slots);
}

/** The export rate each half-hour, p/kWh (export payments carry no VAT): payment ÷ kWh. A day
 *  paid at one rate (each payment within 0.5p of it) fills every half-hour; a varying rate carries on
 *  between readings. */
export function exportRateLine(day, slots) {
  const raw = new Map();
  for (const s of slots) {
    const iv = day?.get(s);
    if (iv && iv.costExc != null && iv.kwh > MIN_KWH) raw.set(s, Math.abs(iv.costExc) / iv.kwh);
  }
  // Octopus rounds each half-hour's AMOUNT, so a flat rate looks uneven on small exports. If every
  // half-hour's payment is within half a penny of one rate × its kWh, the day is that rate.
  let kwh = 0, pay = 0;
  for (const s of raw.keys()) { const iv = day.get(s); kwh += iv.kwh; pay += Math.abs(iv.costExc); }
  if (kwh > MIN_KWH) {
    const r = pay / kwh;
    const flat = [...raw.keys()].every((s) => { const iv = day.get(s); return Math.abs(Math.abs(iv.costExc) - r * iv.kwh) <= 0.5; });
    if (flat) return new Map(slots.map((s) => [s, r]));
  }
  return solid(raw, slots);
}
