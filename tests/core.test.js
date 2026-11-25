import { describe, it, expect } from 'vitest';
import { midnight, slotsOfDay, addMonths, dayKeyOf, slotOf, isoLocal, HALF_HOUR } from '../src/time.js';
import { vatRate } from '../src/vat.js';
import { labelBand, parseNode, byDay } from '../src/measurements.js';
import { billPeriods, anchorFromBillingDay, calendarPeriods, lastYearOf, previousOf } from '../src/periods.js';
import { summarise, slotState } from '../src/bill.js';
import { rateLine } from '../src/rates.js';

// All figures here are fictional.

const node = (startIso, kwh, stats) => ({ startAt: startIso, value: String(kwh), metaData: { statistics: stats } });
const energy = (label, exc, value) => ({ type: 'TOU_BUCKET_COST', label, value: value == null ? null : String(value),
  costExclTax: { estimatedAmount: String(exc) }, costInclTax: { estimatedAmount: String(exc * 1.05) } });
const standing = (exc) => ({ type: 'STANDING_CHARGE_COST', label: null, costExclTax: { estimatedAmount: String(exc) } });

describe('time', () => {
  it('local midnight is 23:00Z in summer, 00:00Z in winter', () => {
    expect(new Date(midnight('2026-07-01')).toISOString()).toBe('2026-06-30T23:00:00.000Z');
    expect(new Date(midnight('2026-12-01')).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
  it('the clocks-forward day has 46 slots, with 01:00–02:00 missing', () => {
    const s = slotsOfDay('2026-03-29');
    expect(s.size).toBe(46);
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(false);
  });
  it('the clocks-back day still has 48 distinct slots (the repeated hour maps twice)', () => {
    expect(slotsOfDay('2026-10-25').size).toBe(48);
  });
  it('months clamp to their length', () => {
    expect(addMonths(2026, 1, 31, 1)).toBe('2026-02-28');
    expect(addMonths(2026, 1, 31, -2)).toBe('2025-11-30');
  });
  it('isoLocal carries the offset', () => {
    expect(isoLocal(midnight('2026-07-01'))).toBe('2026-07-01T00:00:00+01:00');
    expect(isoLocal(midnight('2026-12-01'))).toBe('2026-12-01T00:00:00+00:00');
  });
});

describe('VAT', () => {
  it('is 5% to 30 Sep 2026 and 0% from 1 Oct, at local midnight', () => {
    expect(vatRate('2026-09-30')).toBe(0.05);
    expect(vatRate('2026-10-01')).toBe(0);
    // 23:00Z on 30 Sep is 00:00 on 1 Oct in BST
    expect(vatRate(dayKeyOf(Date.parse('2026-09-30T23:00:00Z')))).toBe(0);
    expect(vatRate(dayKeyOf(Date.parse('2026-09-30T22:30:00Z')))).toBe(0.05);
  });
});

describe('measurements', () => {
  it('classifies labels, off-peak before peak', () => {
    expect(labelBand('OFF_PEAK')).toBe(true);
    expect(labelBand('STANDARD_RATE')).toBe(false);
    expect(labelBand('CONSUMPTION')).toBe(null);
  });
  it('takes the band from the bucket that carries the charge (IOG-SMB lists all four)', () => {
    const iv = parseNode(node('2026-11-02T01:00:00+00:00', 1.2, [
      energy('HOME_OFF_PEAK', 0, 0), energy('HOME_STANDARD_RATE', 0, 0),
      energy('EV_OFF_PEAK', 8.4, 1.2), energy('EV_STANDARD_RATE', 0, 0), standing(1.1),
    ]));
    expect(iv.offPeak).toBe(true);
    expect(iv.costExc).toBeCloseTo(8.4);
    expect(iv.standingExc).toBeCloseTo(1.1);
  });
  it('a node with kWh and no energy statistic has no cost (not zero)', () => {
    const iv = parseNode(node('2026-11-02T01:00:00+00:00', 0.4, [standing(1.1)]));
    expect(iv.costExc).toBe(null);
  });
  it('sums the repeated clocks-back hour into one slot', () => {
    const a = parseNode(node('2026-10-25T00:00:00Z', 0.3, [energy('CONSUMPTION', 6, null)]));   // 01:00 BST
    const b = parseNode(node('2026-10-25T01:00:00Z', 0.2, [energy('CONSUMPTION', 4, null)]));   // 01:00 GMT
    const d = byDay([a, b]).get('2026-10-25');
    expect(d.size).toBe(1);
    expect(d.get(2).kwh).toBeCloseTo(0.5);
    expect(d.get(2).costExc).toBeCloseTo(10);
  });
});

describe('periods', () => {
  it('bill periods step from the anchor, clamping a 31st', () => {
    const ps = billPeriods('2026-01-31', 1, '2026-01-31', '2026-03-31');
    expect(ps.map((p) => p.start)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(ps[1].end).toBe('2026-03-31');
  });
  it('reaches back before the anchor', () => {
    const ps = billPeriods('2026-11-15', 1, '2026-09-20', '2026-11-20');
    expect(ps[0]).toEqual({ start: '2026-09-15', end: '2026-10-15' });
    expect(ps.at(-1)).toEqual({ start: '2026-11-15', end: '2026-12-15' });
  });
  it('quarterly bills step three months', () => {
    const ps = billPeriods('2026-10-07', 3, '2026-04-07', '2026-10-07');
    expect(ps.map((p) => p.start)).toEqual(['2026-04-07', '2026-07-07', '2026-10-07']);
  });
  it('builds an anchor from a billing day', () => {
    expect(anchorFromBillingDay(15, '2026-11-25')).toBe('2026-11-15');
    expect(anchorFromBillingDay(28, '2026-11-25')).toBe('2026-10-28');
    expect(anchorFromBillingDay(31, '2026-02-28')).toBe('2026-02-28');
  });
  it('calendar quarters start on Jan, Apr, Jul, Oct', () => {
    expect(calendarPeriods('quarter', '2026-05-03', '2026-08-01').map((p) => p.start))
      .toEqual(['2026-04-01', '2026-07-01']);
  });
  it('compares with the previous period and the one a year before', () => {
    const list = calendarPeriods('month', '2025-01-01', '2026-11-01');
    const p = list.at(-1);
    expect(previousOf(list, p).start).toBe('2026-10-01');
    expect(lastYearOf(list, p).start).toBe('2025-11-01');
  });
});

// A fictional day: 2026-09-30 (5% VAT) and 2026-10-01 (0%), every slot present but one.
function twoDays() {
  const ivs = [];
  for (const k of ['2026-09-30', '2026-10-01']) {
    let t = midnight(k);
    for (let i = 0; i < 48; i++, t += HALF_HOUR) {
      if (k === '2026-10-01' && i === 10) continue;            // a missing half-hour
      ivs.push({ start: t, kwh: 0.5, costExc: 10, standingExc: 1, offPeak: i < 8 });
    }
  }
  return byDay(ivs);
}

describe('bill', () => {
  const imp = twoDays();
  const cover = { from: '2026-09-01', last: midnight('2026-10-02') - HALF_HOUR };
  it('adds VAT from the calendar to the ex-VAT cost, either side of 1 Oct', () => {
    const s = summarise({ start: '2026-09-30', end: '2026-10-02' }, imp, cover);
    // 30 Sep: 48 × 10p × 1.05 = 504p; 1 Oct: 47 × 10p × 1.00 = 470p
    expect(s.energy).toBeCloseTo(974);
    // standing: 48 × 1p × 1.05 + 47 × 1p = 97.4p
    expect(s.standing).toBeCloseTo(97.4);
    expect(s.kwh).toBeCloseTo(47.5);
    expect(s.missing).toBe(1);
    expect(s.offPeak.kwh).toBeCloseTo(8);
    // 974p over 47.5 kWh
    expect(s.avgRate).toBeCloseTo(974 / 47.5);
  });
  it('a half-hour after the latest reading is pending, not missing', () => {
    const early = { from: '2026-09-01', last: midnight('2026-10-01') + 5 * HALF_HOUR };
    expect(slotState(imp, '2026-10-01', 10, early)).toBe('pending');
    expect(slotState(imp, '2026-10-01', 10, cover)).toBe('missing');
  });
  it('a half-hour before the supply started is outside, not missing', () => {
    expect(slotState(imp, '2026-08-01', 10, cover)).toBe('outside');
  });
  it('export is credited without VAT', () => {
    const exp = byDay([{ start: midnight('2026-09-30') + 24 * HALF_HOUR, kwh: 2, costExc: 30, standingExc: null, offPeak: false }]);
    const s = summarise({ start: '2026-09-30', end: '2026-10-01' }, imp, cover, exp, cover);
    expect(s.exportCredit).toBeCloseTo(30);
    expect(s.net).toBeCloseTo(s.total - 30);
  });
});

describe('rate line', () => {
  const slots = [...Array(48).keys()];
  it('is cost ÷ kWh with VAT, and fills a zero-kWh slot from its band', () => {
    const day = new Map();
    day.set(0, { kwh: 1, costExc: 7, offPeak: true });
    day.set(1, { kwh: 0, costExc: 0, offPeak: true });
    day.set(20, { kwh: 1, costExc: 25, offPeak: false });
    const r = rateLine('2026-09-30', day, slots);
    expect(r.get(0)).toBeCloseTo(7.35);
    expect(r.get(1)).toBeCloseTo(7.35);
    expect(r.get(20)).toBeCloseTo(26.25);
    expect(r.get(5)).toBe(null);          // no reading, two rates that day: a gap
  });
  it('a flat day fills every slot', () => {
    const day = new Map([[0, { kwh: 1, costExc: 24, offPeak: null }]]);
    expect(rateLine('2026-10-01', day, slots).get(30)).toBeCloseTo(24);
  });
  it('published (Agile) rates fill zero-kWh slots', () => {
    const day = new Map([[0, { kwh: 1, costExc: 12, offPeak: null }], [1, { kwh: 1, costExc: 18, offPeak: null }]]);
    const r = rateLine('2026-10-01', day, slots, new Map([[2, 9.5]]));
    expect(r.get(2)).toBeCloseTo(9.5);
    expect(r.get(3)).toBe(null);
  });
});

describe('slot helpers', () => {
  it('slotOf is local', () => {
    expect(slotOf(Date.parse('2026-07-01T00:30:00Z'))).toBe(3);   // 01:30 BST
  });
});

describe('future half-hours', () => {
  it('are neither missing nor pending, and a period is unfinished until it ends', () => {
    const imp = new Map();
    const now = midnight('2026-11-25') + 20 * HALF_HOUR;
    const cover = { from: '2026-01-01', last: now - 30 * HALF_HOUR, now };
    expect(slotState(imp, '2026-11-25', 30, cover)).toBe('future');
    expect(slotState(imp, '2026-11-26', 0, cover)).toBe('future');
    expect(slotState(imp, '2026-11-25', 15, cover)).toBe('pending');
    const s = summarise({ start: '2026-11-14', end: '2026-12-14' }, imp, cover);
    expect(s.days).toBe(12);
    expect(s.finished).toBe(false);
    // 14–24 Nov: 11 days × 48 missing; 25 Nov 00:00–10:00 has 21 slots, of which 0–9 missing
    expect(s.missing + s.pending).toBe(11 * 48 + 21);
  });
});
