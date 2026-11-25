// Octopus GraphQL `measurements` nodes → plain half-hour intervals (EMT's
// kraken_api_client._parse_measurement_node). Money stays in PENCE, excluding VAT.
//
//   { start: ms UTC, kwh, costExc: pence | null, standingExc: pence | null,
//     offPeak: true | false | null, split: { 'ev:off': { kwh, cost }, … } | null }
//
// `split` is Octopus's House/EV split on an IOG-SMB tariff: each bucket's kWh and ex-VAT cost,
// keyed `side:band` (side ev | home; band off | peak | other). It is null on a tariff without EV
// buckets, and null too when a bucket's label is not recognised: the half-hour is then not split
// rather than booked to the wrong side (EMT's bucket_side refusal).
//
// costExc is null when Octopus returned no energy cost for the half-hour (it has the kWh, not
// yet the price). offPeak is null when no single band carried the charge (a flat tariff's bare
// CONSUMPTION label, or home and EV in different bands in the same half-hour).

import { slotOf, dayKeyOf } from './time.js';

// ORDER MATTERS: "PEAK" is inside "OFF_PEAK", so off-peak is tested first (EMT's label_band).
const OFF_PEAK_WORDS = ['OFF_PEAK', 'OFFPEAK', 'NIGHT', 'LOW RATE', 'LOW_RATE'];
const PEAK_WORDS = ['PEAK', 'DAY', 'STANDARD_RATE', 'STANDARD'];

export function labelBand(label) {
  const lab = String(label || '').toUpperCase();
  if (!lab) return null;
  if (OFF_PEAK_WORDS.some((w) => lab.includes(w))) return true;
  if (PEAK_WORDS.some((w) => lab.includes(w))) return false;
  return null;
}

const HEAT_PUMP = (lab) => lab.includes('HP_DEVICE') || lab.startsWith('HP_') || lab.startsWith('HP ') || lab.includes('HEAT PUMP');

/** 'ev' | 'home' | null — which side of Octopus's House/EV split a bucket is (EMT's bucket_side).
 *  ORDER MATTERS: the EV test runs before the house's band words ('EV STANDARD RATE'). */
export function bucketSide(label) {
  const lab = String(label || '').toUpperCase().trim();
  if (!lab) return null;
  if (HEAT_PUMP(lab)) return 'home';            // a heat pump is part of the house in Octopus's split
  if (lab.includes('BOOST')) return 'ev';
  if (lab.includes('EV_DEVICE') || lab.startsWith('EV ') || lab.startsWith('EV_')) return 'ev';
  if (lab.includes('ECO7') || lab.startsWith('HOME ')) return 'home';
  if (['OFF_PEAK', 'OFFPEAK', 'NIGHT', 'STANDARD_RATE', 'STANDARD', 'PEAK', 'DAY', 'CONSUMPTION']
    .some((w) => lab.includes(w))) return 'home';
  return null;
}

const bandKey = (b) => (b === true ? 'off' : b === false ? 'peak' : 'other');

function addTo(map, key, kwh, cost) {
  const e = map[key] || (map[key] = { kwh: 0, cost: 0 });
  e.kwh += kwh;
  e.cost += cost;
}

function amount(block) {
  const v = Number(block?.estimatedAmount);
  return Number.isFinite(v) ? v : 0;
}

export function parseNode(node) {
  if (!node?.startAt) return null;
  const start = Date.parse(node.startAt);
  if (!Number.isFinite(start)) return null;
  let costExc = 0, standingExc = 0, sawEnergy = false, sawStanding = false;
  const bands = new Set();
  const split = {};
  let sawEv = false, unknownSide = false, splitKwh = true;
  for (const s of node.metaData?.statistics || []) {
    if (s.type === 'STANDING_CHARGE_COST') {
      standingExc += amount(s.costExclTax);
      sawStanding = true;
      continue;
    }
    const exc = amount(s.costExclTax);
    costExc += exc;
    sawEnergy = true;
    // The band comes from the bucket that CARRIES the charge: on IOG-SMB every half-hour lists
    // all four buckets, zero where unused, so the set of labels present says nothing.
    let carries = null;
    if (s.value != null && Number.isFinite(Number(s.value))) carries = Math.abs(Number(s.value)) > 1e-9;
    if (carries === null) carries = Math.abs(exc) > 1e-9;
    if (carries) {
      const b = labelBand(s.label);
      if (b !== null) bands.add(b);
    }
    const side = bucketSide(s.label);
    if (side === 'ev') sawEv = true;
    if (side === null) unknownSide = true;
    const v = s.value != null && Number.isFinite(Number(s.value)) ? Number(s.value) : null;
    if (v === null) splitKwh = false;
    if (side) addTo(split, `${side}:${bandKey(labelBand(s.label))}`, v ?? 0, exc);
  }
  const kwh = Number(node.value);
  return {
    start,
    kwh: Number.isFinite(kwh) ? kwh : 0,
    costExc: sawEnergy ? costExc : null,
    standingExc: sawStanding ? standingExc : null,
    offPeak: bands.size === 1 ? [...bands][0] : null,
    split: sawEv && !unknownSide && splitKwh ? split : null,
  };
}

export function mergeSplit(a, b) {
  if (!a || !b) return null;              // one half of the clocks-back hour unsplit: the slot is unsplit
  const out = {};
  for (const m of [a, b]) for (const [k, e] of Object.entries(m)) addTo(out, k, e.kwh, e.cost);
  return out;
}

/**
 * Index intervals by local day and slot. The repeated clocks-back hour's two half-hours land on
 * the same slot and are SUMMED (EMT's heatmap rule); a band that disagrees becomes null. Each slot
 * keeps `starts`, the UTC instants it holds, so a slot with only one of its two readings can be
 * told apart (bill.slotState 'partial').
 * Returns Map<dayKey, Map<slot, interval-like>>.
 */
export function byDay(intervals) {
  const days = new Map();
  for (const iv of intervals) {
    const k = dayKeyOf(iv.start), slot = slotOf(iv.start);
    let day = days.get(k);
    if (!day) days.set(k, (day = new Map()));
    const prev = day.get(slot);
    if (!prev) { day.set(slot, { ...iv, split: iv.split ? structuredClone(iv.split) : null, starts: [iv.start] }); continue; }
    prev.starts.push(iv.start);
    prev.kwh += iv.kwh;
    prev.costExc = prev.costExc == null || iv.costExc == null ? (prev.costExc ?? iv.costExc) : prev.costExc + iv.costExc;
    prev.standingExc = prev.standingExc == null || iv.standingExc == null
      ? (prev.standingExc ?? iv.standingExc) : prev.standingExc + iv.standingExc;
    if (prev.offPeak !== iv.offPeak) prev.offPeak = null;
    prev.split = mergeSplit(prev.split, iv.split);
  }
  return days;
}
