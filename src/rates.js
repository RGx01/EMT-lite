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
