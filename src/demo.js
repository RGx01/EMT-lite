// Demo data: a fictional Intelligent-style account, so the page can be tried before a key is
// pasted. It stands in for the Octopus client, so the demo runs the same code as a real account.
// Every figure is made up.

import { midnight, addDays, HALF_HOUR, slotOf, parseKey, addMonths, todayKey } from './time.js';

// FNV-1a of the day key, then mulberry32: nearby keys must not give nearby first draws.
function seedOf(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OFF_PEAK_EXC = 7.0;     // p/kWh, ex VAT
const PEAK_EXC = 24.5;
const STANDING_EXC_DAY = 48;  // p/day, ex VAT
const EXPORT_P = 15;

export const DEMO_NUMBER = 'A-0000ABC7';

export function demoAccountInfo(today = todayKey()) {
  const { y, m } = parseKey(today);
  const from = addMonths(y, m, 1, -14);
  const ag = (isExport) => [{ validFrom: `${from}T00:00:00+00:00`, validTo: null,
    tariff: { productCode: isExport ? 'DEMO-EXPORT' : 'DEMO-INTELLIGENT', tariffCode: 'DEMO', isExport, displayName: 'Demo' } }];
  return {
    number: DEMO_NUMBER,
    import: { mpan: '2600000000001', agreements: ag(false), from },
    export: { mpan: '2600000000002', agreements: ag(true), from },
    billing: { anchor: addMonths(y, m, 14, today.slice(8) >= '14' ? 0 : -1), months: 1, source: 'demo' },
  };
}

function dayIntervals(k, dir, lastMs) {
  const r = rng(seedOf(`${dir}:${k}`));
  const { m } = parseKey(k);
  const summer = Math.cos(((m - 6.5) / 12) * 2 * Math.PI) * 0.5 + 0.5;   // 0 winter … 1 summer
  const evNight = r() < 0.45;
  const gapDay = r() < 0.012;                                          // a day the meter missed
  const out = [];
  const end = midnight(addDays(k, 1));
  for (let t = midnight(k); t < end && t <= lastMs; t += HALF_HOUR) {
    const slot = slotOf(t);
    if (gapDay && slot >= 16 && slot < 40) continue;
    if (r() < 0.004) continue;                                          // a stray missing half-hour
    if (dir === 'GENERATION') {
      const sun = Math.max(0, Math.sin(((slot - 12) / 28) * Math.PI)) * summer;
      const kwh = sun > 0.05 ? +(sun * (0.6 + r() * 0.9)).toFixed(3) : 0;
      out.push({ start: t, kwh, costExc: kwh * EXPORT_P, standingExc: null, offPeak: false, split: null });
      continue;
    }
    const offPeak = slot >= 47 || slot < 11;
    let home = 0.12 + r() * 0.15;
    if (slot >= 14 && slot <= 17) home += r() * 0.5;
    if (slot >= 34 && slot <= 40) home += 0.4 + r() * 0.8 * (1.3 - summer);
    home = +home.toFixed(3);
    const ev = evNight && offPeak && slot < 9 ? +(3.3 + r() * 0.3).toFixed(3) : 0;
    const kwh = +(home + ev).toFixed(3);
    const rate = offPeak ? OFF_PEAK_EXC : PEAK_EXC;
    const band = offPeak ? 'off' : 'peak', other = offPeak ? 'peak' : 'off';
    // IOG-SMB: four buckets every half-hour, zero where unused
    const split = { [`ev:${band}`]: { kwh: ev, cost: ev * rate }, [`home:${band}`]: { kwh: home, cost: home * rate },
      [`ev:${other}`]: { kwh: 0, cost: 0 }, [`home:${other}`]: { kwh: 0, cost: 0 } };
    const late = Date.now() - t < 3 * 86400000 && r() < 0.5;            // recent: kWh in, cost not yet
    out.push({ start: t, kwh, costExc: late ? null : kwh * rate, standingExc: STANDING_EXC_DAY / 48, offPeak,
      split: late ? null : split });
  }
  return out;
}

/** Stands in for Octopus: same methods the loader calls. */
export class DemoOctopus {
  constructor() { this.lastMs = Date.now() - 26 * 3600 * 1000; }   // readings ~a day behind, as DCC
  async measurements(_n, _mpan, fromKey, toKey, dir) {
    await new Promise((r) => setTimeout(r, 120));
    const out = [];
    for (let k = fromKey; k < toKey; k = addDays(k, 1)) out.push(...dayIntervals(k, dir, this.lastMs));
    return out;
  }
  async measurementsBetween() { return []; }
  async publishedRates() { return []; }
}

