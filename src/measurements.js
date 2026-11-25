// Octopus GraphQL `measurements` nodes → plain half-hour intervals (EMT's
// kraken_api_client._parse_measurement_node). Money stays in PENCE, excluding VAT.
//
//   { start: ms UTC, kwh, costExc: pence | null, standingExc: pence | null,
//     offPeak: true | false | null }
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
  }
  const kwh = Number(node.value);
  return {
    start,
    kwh: Number.isFinite(kwh) ? kwh : 0,
    costExc: sawEnergy ? costExc : null,
    standingExc: sawStanding ? standingExc : null,
    offPeak: bands.size === 1 ? [...bands][0] : null,
  };
}

/**
 * Index intervals by local day and slot. The repeated clocks-back hour's two half-hours land on
 * the same slot and are SUMMED (EMT's heatmap rule); a band that disagrees becomes null.
 * Returns Map<dayKey, Map<slot, interval-like>>.
 */
export function byDay(intervals) {
  const days = new Map();
  for (const iv of intervals) {
    const k = dayKeyOf(iv.start), slot = slotOf(iv.start);
    let day = days.get(k);
    if (!day) days.set(k, (day = new Map()));
    const prev = day.get(slot);
    if (!prev) { day.set(slot, { ...iv }); continue; }
    prev.kwh += iv.kwh;
    prev.costExc = prev.costExc == null || iv.costExc == null ? (prev.costExc ?? iv.costExc) : prev.costExc + iv.costExc;
    prev.standingExc = prev.standingExc == null || iv.standingExc == null
      ? (prev.standingExc ?? iv.standingExc) : prev.standingExc + iv.standingExc;
    if (prev.offPeak !== iv.offPeak) prev.offPeak = null;
  }
  return days;
}
