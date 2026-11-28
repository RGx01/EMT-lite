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
    // standing is a daily charge: 1 Oct's missing reading does not take a share of it away,
    // so both days are whole: 48 × 1p × 1.05 + 48 × 1p = 98.4p
    expect(s.standing).toBeCloseTo(98.4);
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
    // 14–24 Nov: 11 days × 48; 25 Nov: the 20 half-hours finished by 10:00 (10:00–10:30 is in progress)
    expect(s.missing + s.pending).toBe(11 * 48 + 20);
  });
});

import { bucketSide } from '../src/measurements.js';

describe('IOG-SMB House/EV split', () => {
  const smb = (start, ev, home, evOff = true) => node(start, ev + home, [
    energy('HOME_OFF_PEAK', evOff ? home * 7 : 0, evOff ? home : 0),
    energy('HOME_STANDARD_RATE', evOff ? 0 : home * 24.5, evOff ? 0 : home),
    energy('EV_OFF_PEAK', evOff ? ev * 7 : 0, evOff ? ev : 0),
    energy('EV_STANDARD_RATE', evOff ? 0 : ev * 24.5, evOff ? 0 : ev),
    standing(1),
  ]);
  it('classifies both label vocabularies, EV before the band words', () => {
    expect(bucketSide('EV_OFF_PEAK')).toBe('ev');
    expect(bucketSide('EV STANDARD RATE')).toBe('ev');
    expect(bucketSide('EV_BOOST')).toBe('ev');
    expect(bucketSide('HOME_STANDARD_RATE')).toBe('home');
    expect(bucketSide('HP_DEVICE')).toBe('home');
    expect(bucketSide('SOMETHING_NEW')).toBe(null);
  });
  it('keeps each bucket’s kWh and cost', () => {
    const iv = parseNode(smb('2026-11-02T01:00:00Z', 3.5, 0.2));
    expect(iv.split['ev:off'].kwh).toBeCloseTo(3.5);
    expect(iv.split['ev:off'].cost).toBeCloseTo(24.5);
    expect(iv.split['home:off'].kwh).toBeCloseTo(0.2);
    expect(iv.split['ev:peak'].kwh).toBe(0);
  });
  it('refuses the split when a label is unrecognised, rather than guess a side', () => {
    const n = smb('2026-11-02T01:00:00Z', 3.5, 0.2);
    n.metaData.statistics.push(energy('SOMETHING_NEW', 0, 0));
    expect(parseNode(n).split).toBe(null);
  });
  it('a tariff without EV buckets has no split', () => {
    expect(parseNode(node('2026-11-02T01:00:00Z', 1, [energy('CONSUMPTION', 24, 1)])).split).toBe(null);
  });
  it('the bill sums House and EV, with VAT by date', () => {
    const ivs = [
      parseNode(smb('2026-09-29T23:00:00Z', 3.5, 0.2)),           // 30 Sep 00:00 BST, 5%
      parseNode(smb('2026-09-30T23:00:00Z', 3.0, 0.5)),           // 1 Oct 00:00 BST, 0%
      parseNode(smb('2026-10-01T09:00:00Z', 0, 0.4, false)),      // 1 Oct 10:00, peak
    ];
    const s = summarise({ start: '2026-09-30', end: '2026-10-02' }, byDay(ivs),
      { from: '2026-01-01', last: Date.parse('2026-10-01T09:00:00Z') });
    // EV off-peak: 3.5 kWh × 7p × 1.05 + 3.0 kWh × 7p = 25.725 + 21 = 46.725p over 6.5 kWh
    expect(s.split['ev:off'].kwh).toBeCloseTo(6.5);
    expect(s.split['ev:off'].cost).toBeCloseTo(46.725);
    // Home: off-peak 0.2 × 7 × 1.05 + 0.5 × 7 = 4.97p; peak 0.4 × 24.5 = 9.8p
    expect(s.split['home:off'].cost).toBeCloseTo(4.97);
    expect(s.split['home:peak'].cost).toBeCloseTo(9.8);
    // the split adds up to the energy total
    const sum = Object.values(s.split).reduce((a, e) => a + e.cost, 0);
    expect(sum).toBeCloseTo(s.energy);
    expect(s.unsplitSlots).toBe(0);
  });
});

import { cellOf } from '../src/heatmap.js';

describe('net heatmap cells', () => {
  const k = '2026-11-10', t = (s) => midnight(k) + s * HALF_HOUR;
  const cover = { from: '2026-01-01', last: midnight('2026-11-11'), now: midnight('2026-11-12') };
  const iv = (s, kwh) => ({ start: t(s), kwh, costExc: 1, standingExc: 1, offPeak: null, split: null });
  // slot 0 both, 1 export missing, 2 import missing, 3 both missing
  const imp = byDay([iv(0, 0.5), iv(1, 0.4)]);
  const exp = byDay([iv(0, 0.2), iv(2, 1.5)]);

  it('both present: import − export, no hatch', () => {
    const c = cellOf(imp, cover, exp, cover, k, 0);
    expect(c.value).toBeCloseTo(0.3);
    expect(c.hatch).toBe(null);
  });
  it('export missing: the import alone, hatched green', () => {
    const c = cellOf(imp, cover, exp, cover, k, 1);
    expect(c.value).toBeCloseTo(0.4);
    expect(c.hatch).toBe('green');
  });
  it('import missing: the export alone (negative), hatched red', () => {
    const c = cellOf(imp, cover, exp, cover, k, 2);
    expect(c.value).toBeCloseTo(-1.5);
    expect(c.hatch).toBe('red');
  });
  it('both missing: black and white, no colour', () => {
    const c = cellOf(imp, cover, exp, cover, k, 3);
    expect(c.value).toBe(null);
    expect(c.hatch).toBe('bw');
  });
  it('no export meter: a missing import is black and white', () => {
    expect(cellOf(imp, cover, null, null, k, 3).hatch).toBe('bw');
    expect(cellOf(imp, cover, null, null, k, 1).hatch).toBe(null);
  });
  it('an export meter supplied only later is not missing before it started', () => {
    const late = { ...cover, from: '2026-11-20' };
    expect(cellOf(imp, cover, exp, late, k, 1).hatch).toBe(null);
  });
});

import { chooseBilling, triggerDay, describeAccount } from '../src/data.js';

describe('the billing day', () => {
  const today = '2026-11-25';
  it('defaults to the 1st when Octopus says nothing', () => {
    const b = chooseBilling({ today });
    expect(b).toMatchObject({ day: 1, source: 'default', anchor: '2026-11-01' });
  });
  it('takes a monthly billing trigger day', () => {
    const trigger = { isActive: true, operationFrequencies: [{ frequency: 'MONTHLY', multiplier: 1, triggerAtStartDay: 3 }] };
    expect(triggerDay(trigger)).toBe(3);
    expect(chooseBilling({ trigger, today })).toMatchObject({ day: 3, source: 'trigger', anchor: '2026-11-03' });
  });
  it('ignores an inactive trigger', () => {
    expect(triggerDay({ isActive: false, operationFrequencies: [{ frequency: 'MONTHLY', multiplier: 1, triggerAtStartDay: 3 }] })).toBe(null);
  });
  it('a day the user chose wins over everything', () => {
    const info = { billing: { day: 9, anchor: '2026-11-09', months: 1, source: 'octopus' } };
    expect(chooseBilling({ userDay: 3, info, today })).toMatchObject({ day: 3, source: 'user' });
  });
  it('does not take the current period start as the billing day', () => {
    const info = describeAccount('A-0000ABC7', { billingOptions: { currentBillingPeriodStartDate: '2026-11-07' }, properties: [] }, today);
    expect(info.billing).toBe(null);
  });
});

describe('today on the heatmap', () => {
  it('a finished half-hour today with no reading is hatched; the one in progress is not', () => {
    const now = midnight('2026-11-25') + 20 * HALF_HOUR + 60000;            // 10:01
    const cover = { from: '2026-01-01', last: midnight('2026-11-24') + 40 * HALF_HOUR, now };
    const empty = new Map();
    expect(cellOf(empty, cover, empty, cover, '2026-11-25', 19).hatch).toBe('bw');
    expect(cellOf(empty, cover, empty, cover, '2026-11-25', 20).hatch).toBe(null);
    expect(cellOf(empty, cover, null, null, '2026-11-24', 45).hatch).toBe('bw');
  });
});

import { solid, sideRateLine, inIogWindow, offWindowOf } from '../src/rates.js';

describe('solid rate lines', () => {
  const slots = [0, 1, 2, 3, 4];
  it('fills gaps from the rate before, and a leading gap from the first rate', () => {
    const r = solid(new Map([[0, null], [1, 7], [2, null], [3, 24], [4, null]]), slots);
    expect([...r.values()]).toEqual([7, 7, 7, 24, 24]);
  });
  it('a side that drew nothing takes its band’s rate, then the other side’s', () => {
    const sp = (ev, home, band) => ({ [`ev:${band}`]: { kwh: ev, cost: ev * (band === 'off' ? 7 : 24.5) },
      [`home:${band}`]: { kwh: home, cost: home * (band === 'off' ? 7 : 24.5) } });
    // 14:00 a dispatch, 14:30 peak (afternoon: outside IOG's 23:30–05:30 window)
    const day = new Map([
      [28, { kwh: 3.7, offPeak: true, split: sp(3.5, 0.2, 'off') }],
      [29, { kwh: 0.3, offPeak: false, split: sp(0, 0.3, 'peak') }],
    ]);
    const ev = sideRateLine('2026-10-01', day, [28, 29], 'ev');
    expect(ev.get(28)).toBeCloseTo(7);
    expect(ev.get(29)).toBeCloseTo(24.5);    // EV drew nothing at peak: the house's peak rate
    const home = sideRateLine('2026-10-01', day, [28, 29], 'home');
    expect(home.get(29)).toBeCloseTo(24.5);
  });
});

describe('IOG-SMB rate lines: a side that drew nothing', () => {
  const sp = (evOff, homeOff, homePeak) => ({
    'ev:off': { kwh: evOff, cost: evOff * 7 }, 'ev:peak': { kwh: 0, cost: 0 },
    'home:off': { kwh: homeOff, cost: homeOff * 7 }, 'home:peak': { kwh: homePeak, cost: homePeak * 30 },
  });
  // 20:00 house peak; 20:30–21:00 a dispatch (EV off-peak, house off-peak); 21:30–23:00 the house
  // draws nothing (a battery); 23:30 the window
  const day = new Map([
    [40, { kwh: 0.4, offPeak: false, split: sp(0, 0, 0.4) }],
    [41, { kwh: 3.6, offPeak: true, split: sp(3.4, 0.2, 0) }],
    [42, { kwh: 3.5, offPeak: true, split: sp(3.4, 0.1, 0) }],
    [43, { kwh: 0, offPeak: null, split: sp(0, 0, 0) }],
    [44, { kwh: 0, offPeak: null, split: sp(0, 0, 0) }],
    [47, { kwh: 0, offPeak: null, split: sp(0, 0, 0) }],
  ]);
  const slots = [40, 41, 42, 43, 44, 45, 46, 47];
  it('is at peak after the dispatch ends, not carried at the dispatch’s off-peak', () => {
    const home = sideRateLine('2026-11-22', day, slots, 'home');
    expect(home.get(42)).toBeCloseTo(7);
    expect(home.get(43)).toBeCloseTo(30);
    expect(home.get(46)).toBeCloseTo(30);      // no reading at all: still peak by the time of day
    expect(home.get(47)).toBeCloseTo(7);       // 23:30: the off-peak window
  });
  it('the EV line follows the same bands', () => {
    const ev = sideRateLine('2026-11-22', day, slots, 'ev');
    expect(ev.get(41)).toBeCloseTo(7);
    expect(ev.get(43)).toBeCloseTo(30);        // EV has no peak rate that day: the house's
    expect(ev.get(47)).toBeCloseTo(7);
  });
});

import { exportRateLine } from '../src/rates.js';

describe('export rate line', () => {
  it('a flat export rate fills the day, with no VAT', () => {
    const day = new Map([[24, { kwh: 1.2, costExc: 18 }], [26, { kwh: 0.4, costExc: 6 }]]);
    const r = exportRateLine(day, [0, 24, 26, 47]);
    expect([...r.values()]).toEqual([15, 15, 15, 15]);
  });
  it('a day with no export has no line', () => {
    expect([...exportRateLine(new Map([[0, { kwh: 0, costExc: 0 }]]), [0, 1]).values()]).toEqual([null, null]);
  });
});

describe('export rate rounding', () => {
  it('a flat rate returned with rounding noise is drawn flat', () => {
    const day = new Map([[24, { kwh: 0.07, costExc: 1 }], [25, { kwh: 1.2, costExc: 18 }], [26, { kwh: 0.13, costExc: 2 }]]);
    const r = exportRateLine(day, [24, 25, 26]);
    expect(new Set(r.values()).size).toBe(1);
  });
  it('a varying rate (Agile Outgoing) is kept', () => {
    const day = new Map([[24, { kwh: 1, costExc: 5 }], [25, { kwh: 1, costExc: 18 }]]);
    expect(exportRateLine(day, [24, 25]).get(24)).toBeCloseTo(5);
  });
});

import { AccountData } from '../src/data.js';

describe('loading months several at a time', () => {
  // A fake Octopus whose answers arrive only when released, whatever order they were asked in.
  function fake() {
    const waiting = new Map();
    const octo = {
      calls: [],
      measurements(_n, mpan, from) {
        octo.calls.push(`${mpan}:${from}`);
        return new Promise((resolve) => waiting.set(`${mpan}:${from}`, () => resolve([])));
      },
      measurementsBetween: async () => [],
      publishedRates: async () => [],
    };
    const release = async (...ks) => { for (const k of ks) waiting.get(k)(); await new Promise((r) => setTimeout(r, 0)); };
    return { octo, release };
  }
  const info = { number: 'A-0000ABC7', import: { mpan: 'I', agreements: [], from: null }, export: { mpan: 'E', agreements: [], from: null }, billing: null };
  const NOV = ['2026-11-01', '2026-11-11', '2026-11-21'], OCT = ['2026-10-01', '2026-10-09', '2026-10-17', '2026-10-25'];
  const all = (days) => days.flatMap((d) => [`I:${d}`, `E:${d}`]);

  it('asks a month as windows of at most 10 days, import and export at the same time', async () => {
    const { octo, release } = fake();
    const d = new AccountData(octo, info);
    const p = d.loadMonth({ start: '2026-11-01', end: '2026-12-01' });
    await new Promise((r) => setTimeout(r, 0));
    expect(octo.calls.sort()).toEqual(all(NOV).sort());
    await release(...all(NOV));
    await p;
    expect(d.loaded).toEqual(['2026-11-01']);
  });
  it('shows only the unbroken run of months back from now', async () => {
    const { octo, release } = fake();
    const d = new AccountData(octo, info);
    const today = '2026-11-25';
    const nov = d.loadMonth({ start: '2026-11-01', end: '2026-12-01' });
    const oct = d.loadMonth({ start: '2026-10-01', end: '2026-11-01' });
    await new Promise((r) => setTimeout(r, 0));
    await release(...all(OCT)); await oct;
    expect(d.shownMonths(today)).toEqual([]);                 // October is in, November is not
    await release(...all(NOV)); await nov;
    expect(d.shownMonths(today).map((m) => m.start)).toEqual(['2026-11-01', '2026-10-01']);
  });
});

import { dayWindows, noon } from '../src/time.js';

describe('10-day windows', () => {
  it('a 31-day month is four windows from local midnights, none over 10 days', () => {
    const ws = dayWindows('2026-10-01', '2026-11-01', 10);
    expect(ws.map((w) => w.start)).toEqual(['2026-10-01', '2026-10-09', '2026-10-17', '2026-10-25']);
    expect(ws.at(-1).end).toBe('2026-11-01');
    for (const w of ws) expect((midnight(w.end) - midnight(w.start)) / HALF_HOUR).toBeLessThanOrEqual(500);
  });
  it('local noon is 11:00Z in summer and 12:00Z in winter', () => {
    expect(new Date(noon('2026-07-01')).toISOString()).toBe('2026-07-01T11:00:00.000Z');
    expect(new Date(noon('2026-12-01')).toISOString()).toBe('2026-12-01T12:00:00.000Z');
  });
});

import { recoverCosts } from '../src/octopus.js';

describe('cost recovery, in EMT\u2019s order', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  // records each window asked, as local ISO pairs; answers with costs only for `costs` windows
  const recorder = (costs = new Map()) => {
    const o = { asked: [],
      measurementsBetween: async (_n, _m, a, b) => { o.asked.push([isoLocal(a), isoLocal(b)]); return costs.get(`${a}`) || []; } };
    return o;
  };
  const iv = (k, slot, cost) => ({ start: midnight(k) + slot * HALF_HOUR, kwh: 0.5, costExc: cost, split: null });

  it('a window with no costs at all is still recovered (a midnight start can cost nothing)', async () => {
    const o = recorder();
    await recoverCosts(o, 'A', 'M', [iv('2026-04-24', 4, null)], 'CONSUMPTION', dayKeyOf, now, '2026-01-01');
    expect(o.asked.length).toBe(3);
  });
  it('asks the day, then the month, then noon to noon: the noon before for a morning half-hour', async () => {
    const o = recorder();
    await recoverCosts(o, 'A', 'M', [iv('2026-04-24', 4, null)], 'CONSUMPTION', dayKeyOf, now, '2026-01-01');
    expect(o.asked).toEqual([
      ['2026-04-24T00:00:00+01:00', '2026-04-25T00:00:00+01:00'],
      ['2026-04-01T00:00:00+01:00', '2026-05-01T00:00:00+01:00'],
      ['2026-04-23T12:00:00+01:00', '2026-04-24T12:00:00+01:00'],
    ]);
  });
  it('an afternoon half-hour is asked from that noon to the next', async () => {
    const o = recorder();
    await recoverCosts(o, 'A', 'M', [iv('2026-04-24', 30, null)], 'CONSUMPTION', dayKeyOf, now, '2026-01-01');
    expect(o.asked.at(-1)).toEqual(['2026-04-24T12:00:00+01:00', '2026-04-25T12:00:00+01:00']);
  });
  it('stops once a window has the cost, and carries the split with it', async () => {
    const day = midnight('2026-04-24');
    const got = [{ start: day + 4 * HALF_HOUR, kwh: 0.5, costExc: 3.5, standingExc: 1, offPeak: true, split: { 'ev:off': { kwh: 0.5, cost: 3.5 } } }];
    const o = recorder(new Map([[`${day}`, got]]));
    const ivs = [iv('2026-04-24', 4, null)];
    await recoverCosts(o, 'A', 'M', ivs, 'CONSUMPTION', dayKeyOf, now, '2026-01-01');
    expect(o.asked.length).toBe(1);
    expect(ivs[0].costExc).toBe(3.5);
    expect(ivs[0].split['ev:off'].kwh).toBe(0.5);
  });
  it('days before the supply started, and the last three days, are not asked', async () => {
    const o = recorder();
    await recoverCosts(o, 'A', 'M', [iv('2026-06-02', 4, null), iv('2026-11-24', 4, null)], 'CONSUMPTION', dayKeyOf, now, '2026-06-04');
    expect(o.asked.length).toBe(0);
  });
});


import { memoryCache, reusable, SETTLE_DAYS, CACHE_SHAPE, monthKey } from '../src/cache.js';

describe('the device cache', () => {
  const info = { number: 'A-0000ABC7', import: { mpan: '2600000000001', agreements: [], from: null }, export: null, billing: null };
  const sep = { start: '2026-09-01', end: '2026-10-01' };
  const counting = () => {
    const o = { n: 0,
      measurements: async (_a, _m, from) => { o.n++; return from === '2026-09-01' ? [{ start: midnight('2026-09-01'), kwh: 0.5, costExc: 12, standingExc: 1, offPeak: false, split: null }] : []; },
      measurementsBetween: async () => { o.n++; return []; }, publishedRates: async () => [] };
    return o;
  };
  it('a month fetched once it had settled is used from the device, with no request', async () => {
    const cache = memoryCache();
    const first = new AccountData(counting(), info, cache);
    const realNow = Date.now;
    Date.now = () => midnight('2026-10-01') + (SETTLE_DAYS + 1) * 86400000;
    try {
      expect(await first.loadMonth(sep)).toBe('octopus');
      const o = counting();
      const again = new AccountData(o, info, cache);
      expect(await again.loadMonth(sep)).toBe('device');
      expect(o.n).toBe(0);
      expect(again.imp).toHaveLength(1);
      expect(again.impDays.get('2026-09-01').get(0).costExc).toBe(12);
    } finally {
      Date.now = realNow;
    }
  });
  it('a month fetched before it had settled is asked again', async () => {
    const cache = memoryCache();
    const realNow = Date.now;
    Date.now = () => midnight('2026-10-05');
    try {
      await new AccountData(counting(), info, cache).loadMonth(sep);
    } finally {
      Date.now = realNow;
    }
    const o = counting();
    expect(await new AccountData(o, info, cache).loadMonth(sep)).toBe('octopus');
    expect(o.n).toBeGreaterThan(0);
  });
  it('an entry of an older shape is asked again', () => {
    expect(reusable({ shape: CACHE_SHAPE - 1, fetchedAt: Date.now() }, sep)).toBe(false);
    expect(reusable({ shape: CACHE_SHAPE, fetchedAt: Date.now() }, sep)).toBe(true);
  });
  it('without a cache (Remember me off), every month is asked', async () => {
    const o = counting();
    expect(await new AccountData(o, info, null).loadMonth(sep)).toBe('octopus');
    expect(o.n).toBeGreaterThan(0);
  });
});

import { daySummary, dayBarText } from '../src/heatmap.js';

describe('the heatmap\'s day bars', () => {
  const k = '2026-11-10', t = (s) => midnight(k) + s * HALF_HOUR;
  const cover = { from: '2026-01-01', last: midnight('2026-11-11'), now: midnight('2026-11-12') };
  const iv = (s, kwh) => ({ start: t(s), kwh, costExc: 1, standingExc: 1, offPeak: null, split: null });
  const imp = byDay([iv(0, 0.5), iv(1, 0.4)]);
  const exp = byDay([iv(0, 0.2), iv(2, 1.5)]);
  const cells = Array.from({ length: 48 }, (_, s) => cellOf(imp, cover, exp, cover, k, s));

  it('a day\'s bar says its net, import, export and missing half-hours', () => {
    const d = daySummary(cells);
    expect(d.net).toBeCloseTo(0.5 - 0.2 + 0.4 - 1.5);
    expect(d.imp).toBeCloseTo(0.9);
    expect(d.exp).toBeCloseTo(1.7);
    expect([d.missImp, d.missExp]).toEqual([46, 46]);
    expect(dayBarText(k, d, true)).toBe('Tue 10 Nov 2026 · net -0.80 kWh · import 0.90 kWh · export 1.70 kWh · 46 import, 46 export half-hours missing');
  });
  it('without an export meter, only the import', () => {
    const only = Array.from({ length: 48 }, (_, s) => cellOf(imp, cover, null, null, k, s));
    expect(dayBarText(k, daySummary(only), false)).toBe('Tue 10 Nov 2026 · 0.90 kWh · 46 import half-hours missing');
  });
  it('a day with no readings says so', () => {
    const none = Array.from({ length: 48 }, (_, s) => cellOf(new Map(), cover, null, null, k, s));
    expect(dayBarText(k, daySummary(none), false)).toBe('Tue 10 Nov 2026 · no readings · 48 import half-hours missing');
  });
});

import { accountVat, BUSINESS_VAT_DEFAULT } from '../src/data.js';
import { addDays } from '../src/time.js';
import { vatFor, statutoryRate } from '../src/vat.js';
import { vatNote } from '../src/bills.js';

describe('business VAT', () => {
  const ag = (inc, exc, from = '2025-01-01T00:00:00Z', to = null) => ({ validFrom: from, validTo: to,
    tariff: { standingCharge: inc, preVatStandingCharge: exc } });

  it('a domestic account follows the calendar', () => {
    const v = accountVat('DOMESTIC', [ag(60, 50)]);
    expect(v).toEqual({ business: false, rate: null, source: 'calendar' });
    expect(vatFor(v)('2026-09-30')).toBe(0.05);
    expect(vatFor(v)('2026-10-01')).toBe(0);
  });
  it('a business account pays the rate its tariff carries, on every day', () => {
    const v = accountVat('BUSINESS', [ag(60, 50)]);
    expect(v).toEqual({ business: true, rate: 0.2, source: 'tariff' });
    expect(vatFor(v)('2026-09-30')).toBe(0.2);
    expect(vatFor(v)('2026-10-01')).toBe(0.2);
  });
  it('a business under the de minimis limit pays 5%, read through Octopus’s rounding', () => {
    expect(accountVat('BUSINESS_OCCUPIER', [ag(25.2, 24.0)]).rate).toBe(0.05);
    expect(accountVat('BUSINESS', [ag(41.9475, 39.95)]).rate).toBe(0.05);
  });
  it('the agreement in force now decides, not an older one', () => {
    const now = Date.parse('2026-11-25T12:00:00Z');
    const ags = [ag(52.5, 50, '2024-01-01T00:00:00Z', '2025-01-01T00:00:00Z'), ag(60, 50, '2025-01-01T00:00:00Z')];
    expect(accountVat('BUSINESS', ags, now).rate).toBe(0.2);
  });
  it('a business tariff that shows no VAT falls back to the standard rate', () => {
    expect(accountVat('BUSINESS', [ag(null, null)])).toEqual({ business: true, rate: BUSINESS_VAT_DEFAULT, source: 'default' });
    expect(accountVat('BUSINESS', [ag(57, 50)]).source).toBe('default');   // 14%: not a UK rate
    expect(statutoryRate(0.195)).toBe(0.2);
    expect(statutoryRate(0.14)).toBe(null);
  });
  it('describeAccount reads the account type', () => {
    const acc = (type) => ({ accountType: type, properties: [{ electricityMeterPoints: [
      { mpan: '2600000000001', direction: 'IMPORT', agreements: [ag(60, 50)] }] }] });
    expect(describeAccount('A-0000ABC7', acc('BUSINESS')).vat.rate).toBe(0.2);
    expect(describeAccount('A-0000ABC7', acc('DOMESTIC')).vat.business).toBe(false);
  });
  it('the bill adds a business account’s VAT after 1 Oct 2026, where the domestic calendar adds none', () => {
    const k = '2026-10-10';
    // a whole day: 2 kWh in the first half-hour, the 40p standing charge spread over all 48
    const days = byDay(Array.from({ length: 48 }, (_, s) => ({ start: midnight(k) + s * HALF_HOUR, kwh: s ? 0 : 2,
      costExc: s ? 0 : 50, standingExc: 40 / 48, offPeak: null, split: null })));
    const cover = { from: '2026-01-01', last: midnight('2026-10-11'), now: midnight('2026-10-12') };
    const period = { start: k, end: addDays(k, 1) };
    const biz = summarise(period, days, cover, null, null, vatFor(accountVat('BUSINESS', [ag(60, 50)])));
    const dom = summarise(period, days, cover, null, null);
    expect(dom.energy).toBeCloseTo(50);
    expect(biz.energy).toBeCloseTo(60);
    expect(biz.standing).toBeCloseTo(48);
  });
  it('the rate line includes a business account’s VAT', () => {
    const k = '2026-10-10';
    const day = byDay([{ start: midnight(k), kwh: 2, costExc: 50, standingExc: 40, offPeak: null, split: null }]).get(k);
    expect(rateLine(k, day, [0], null, vatFor({ business: true, rate: 0.2 })).get(0)).toBeCloseTo(30);
    expect(rateLine(k, day, [0], null).get(0)).toBeCloseTo(25);
  });
  it('the bill card says which VAT it added', () => {
    expect(vatNote({ business: false })).toMatch(/domestic rate/);
    expect(vatNote({ business: true, rate: 0.2, source: 'tariff' })).toMatch(/VAT at 20% .*business account, at the rate your tariff carries/);
    expect(vatNote({ business: true, rate: 0.2, source: 'default' })).toMatch(/standard rate/);
  });
});

import { buildSchema } from 'graphql';
import { checkDocuments } from '../scripts/kraken-check.js';
import { ALL_DOCUMENTS } from '../src/queries.js';

describe('the Kraken schema check', () => {
  const schema = buildSchema(`
    type Query { account(accountNumber: String!): Account }
    type Account { number: String, accountType: String @deprecated(reason: "Use kind. Removal 2027-01-01."), kind: String }
  `);
  it('passes a document the schema has', () => {
    expect(checkDocuments(schema, { a: 'query { account(accountNumber: "x") { number kind } }' })).toEqual([]);
  });
  it('flags a deprecated field, with its reason', () => {
    const f = checkDocuments(schema, { a: 'query { account(accountNumber: "x") { accountType } }' });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ document: 'a', kind: 'deprecated' });
    expect(f[0].message).toMatch(/accountType.*deprecated.*Removal 2027-01-01/);
  });
  it('flags a field Octopus no longer has as invalid', () => {
    const f = checkDocuments(schema, { a: 'query { account(accountNumber: "x") { billingOptions { periodStartDay } } }' });
    expect(f.map((x) => x.kind)).toEqual(['invalid']);
    expect(f[0].message).toMatch(/billingOptions/);
  });
  it('flags a document that does not parse', () => {
    expect(checkDocuments(schema, { a: 'query {' })[0].kind).toBe('invalid');
  });
  it('every document the page sends parses', () => {
    for (const [name, src] of Object.entries(ALL_DOCUMENTS)) {
      const f = checkDocuments(schema, { [name]: src }).filter((x) => /does not parse/.test(x.message));
      expect(f, name).toEqual([]);
    }
  });
});

import { billMethod, penny, vatLabel } from '../src/bill.js';

describe('Bill Rounding (EMT’s bill method)', () => {
  const cover = { from: '2026-01-01', last: midnight('2026-10-03'), now: midnight('2026-10-04') };
  // A day's energy is 3 half-hours of 0.3335p ex VAT = 1.0005p, which a bill rounds ONCE (1p), not
  // per half-hour (3 × 0p); the rest of the day draws nothing. The 48.0004p daily standing charge
  // is spread over all 48 half-hours, as Octopus spreads it.
  const ivs = (k, daily = 48.0004) => Array.from({ length: 48 }, (_, i) => ({ start: midnight(k) + i * HALF_HOUR,
    kwh: i < 3 ? 0.1 : 0, costExc: i < 3 ? 0.3335 : 0, standingExc: daily / 48, offPeak: false, split: null }));

  it('sums every half-hour unrounded and rounds each line once', () => {
    const imp = byDay([...ivs('2026-09-29'), ...ivs('2026-09-30')]);
    const s = summarise({ start: '2026-09-29', end: '2026-10-01' }, imp, cover);
    const b = s.bill;
    expect(b.energyExc).toBe(2);                      // 6 × 0.3335 = 2.001 → 2p
    expect(b.standingExc).toBe(96);                   // 2 × 48.0004 = 96.0008 → 96p
    expect(b.standing).toHaveLength(1);
    expect(b.standing[0]).toMatchObject({ days: 2, exc: 96 });
    expect(b.standing[0].rateExc).toBeCloseTo(48.0004, 6);
    expect(b.subtotalExc).toBe(98);
    expect(b.vat).toBe(5);                            // 98.0018 × 5% = 4.90009 → 5p
    expect(b.incTotal).toBe(103);                     // 102.9019 → 103p
    expect(b.total).toBe(103);
    expect(b.vatLabel).toBe('VAT @ 5%');
  });
  it('the total is Total incl. VAT less the export credit as printed', () => {
    const imp = byDay(ivs('2026-09-30'));
    const exp = byDay([{ start: midnight('2026-09-30') + 24 * HALF_HOUR, kwh: 1.3, costExc: 19.4949, standingExc: null, offPeak: false }]);
    const s = summarise({ start: '2026-09-30', end: '2026-10-01' }, imp, cover, exp, cover);
    expect(s.bill.exportCredit).toBe(19);
    expect(s.bill.total).toBe(s.bill.incTotal - 19);
  });
  it('names each VAT rate in force when a period spans a change', () => {
    const imp = byDay([...ivs('2026-09-30'), ...ivs('2026-10-01')]);
    const s = summarise({ start: '2026-09-30', end: '2026-10-02' }, imp, cover);
    expect(s.bill.vatLabel).toBe('VAT @ 5% to 30 Sep, 0% from 1 Oct');
    // VAT only on 30 Sep: (1.0005 + 48.0004) × 5% = 2.45 → 2p; the ex-VAT standing rate is one line
    expect(s.bill.vat).toBe(2);
    expect(s.bill.standing).toHaveLength(1);
    expect(vatLabel({ '2026-11-01': 0, '2026-11-02': 0 })).toBe('VAT @ 0%');
  });
  it('a change in the daily standing charge is its own line', () => {
    const a = ivs('2026-09-28'), b = ivs('2026-09-29', 50);
    const s = summarise({ start: '2026-09-28', end: '2026-09-30' }, byDay([...a, ...b]), cover);
    expect(s.bill.standing.map((g) => [g.days, g.exc])).toEqual([[1, 48], [1, 50]]);
  });
  it('rounds half a penny to even, as Python’s round does', () => {
    expect([penny(266.5), penny(267.5), penny(266.4999), penny(266.5001), penny(-2.5)]).toEqual([266, 268, 266, 267, -2]);
  });
  it('billMethod is a pure function of the unrounded sums', () => {
    const b = billMethod({ energy: 100.6, standing: 0, energyExc: 100.6, standingDays: {}, vatByDay: {}, exportCredit: 0 });
    expect(b.incTotal).toBe(101);
    expect(b.vatLabel).toBe('VAT @ 0%');
  });
});

import { pounds } from '../src/bill.js';
describe('pounds', () => {
  it('puts a credit’s minus before the pound sign', () => {
    expect([pounds(-567), pounds(1234), pounds(0), pounds(-0.001)]).toEqual(['−£5.67', '£12.34', '£0.00', '£0.00']);
  });
});

describe('IOG rate line: a half-hour with no import (no Octopus split)', () => {
  // An Intelligent day without the House/EV split: peak 30p, off-peak 5p ex VAT (made-up rates).
  // A dispatch 19:30–20:30 (slots 39–40), then nothing drawn 20:30–22:30 (slots 41–44), peak at
  // 23:00 (46), and the IOG window from 23:30 (47).
  const k = '2026-11-10', t = (s) => midnight(k) + s * HALF_HOUR;
  const iv = (s, kwh, rate, offPeak) => ({ start: t(s), kwh, costExc: kwh * rate, standingExc: 0, offPeak, split: null });
  const zero = (s) => ({ start: t(s), kwh: 0, costExc: 0, standingExc: 0, offPeak: null, split: null });
  const day = byDay([
    iv(37, 0.2, 30, false), iv(38, 0.2, 30, false), iv(39, 3, 5, true), iv(40, 3, 5, true),
    zero(41), zero(42), zero(43), zero(44), zero(45), iv(46, 0.1, 30, false), iv(47, 3, 5, true),
  ]).get(k);
  const slots = [...slotsOfDay(k)].sort((a, b) => a - b);
  const line = solid(rateLine(k, day, slots, null, () => 0, inIogWindow), slots);

  it('goes back to peak when the dispatch ends, not the off-peak rate carried on', () => {
    for (const s of [41, 42, 43, 44, 45]) expect(line.get(s), `slot ${s}`).toBeCloseTo(30);
  });
  it('keeps what Octopus charged where there was import', () => {
    expect(line.get(40)).toBeCloseTo(5);
    expect(line.get(46)).toBeCloseTo(30);
    expect(line.get(47)).toBeCloseTo(5);
  });
  it('an empty half-hour inside 23:30–05:30 is off-peak', () => {
    const night = byDay([iv(46, 0.1, 30, false), zero(47), iv(10, 3, 5, true), zero(2)]).get(k);
    const l = solid(rateLine(k, night, slots, null, () => 0, inIogWindow), slots);
    expect(l.get(47)).toBeCloseTo(5);
    expect(l.get(2)).toBeCloseTo(5);
  });
  it('the window applies to Intelligent tariffs only', () => {
    expect(offWindowOf({ productCode: 'INTELLI-VAR-24-10-29' })).toBe(inIogWindow);
    expect(offWindowOf({ productCode: 'INTELLI-BB-VAR-23-03-01' })).toBe(inIogWindow);
    expect(offWindowOf({ productCode: 'AGILE-24-10-01' })).toBe(null);
    expect(offWindowOf(null)).toBe(null);
  });
  it('without a window (not Intelligent) the line still carries on, as before', () => {
    const l = solid(rateLine(k, day, slots, null, () => 0), slots);
    expect(l.get(41)).toBeCloseTo(5);
  });
});

import { repeatedSlots } from '../src/time.js';

describe('the clocks-back day: one of a repeated half-hour’s two readings missing', () => {
  // 25 Oct 2026: 01:00 and 01:30 happen twice, in BST (00:00Z, 00:30Z) then GMT (01:00Z, 01:30Z).
  const k = '2026-10-25';
  const iv = (iso, kwh) => ({ start: Date.parse(iso), kwh, costExc: kwh * 20, standingExc: 0, offPeak: null, split: null });
  // every half-hour of the day, then drop the GMT 01:00 reading (slot 2's second half)
  const all = [];
  for (let t = midnight(k); t < midnight('2026-10-26'); t += HALF_HOUR) all.push(iv(new Date(t).toISOString(), 0.5));
  const gappy = all.filter((x) => x.start !== Date.parse('2026-10-25T01:00:00Z'));
  const cover = { from: '2026-01-01', last: midnight('2026-10-26') - HALF_HOUR, now: midnight('2026-10-27') };

  it('only the clocks-back day has repeated slots: 01:00 and 01:30', () => {
    expect([...repeatedSlots(k)].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(repeatedSlots('2026-10-24').size).toBe(0);
    expect(repeatedSlots('2026-03-29').size).toBe(0);      // clocks forward: shorter, nothing twice
  });
  it('(guard) both readings there: present, summed', () => {
    const d = byDay(all);
    expect(slotState(d, k, 2, cover)).toBe('present');
    expect(d.get(k).get(2).kwh).toBeCloseTo(1.0);
  });
  it('one of the two missing: partial, not present', () => {
    const d = byDay(gappy);
    expect(slotState(d, k, 2, cover)).toBe('partial');
    expect(slotState(d, k, 3, cover)).toBe('present');
    expect(d.get(k).get(2).kwh).toBeCloseTo(0.5);
  });
  it('(guard) the other half not in yet (after the latest reading) is not missing', () => {
    const early = gappy.filter((x) => x.start < Date.parse('2026-10-25T01:00:00Z'));
    const c = { ...cover, last: Date.parse('2026-10-25T00:30:00Z') };
    expect(slotState(byDay(early), k, 2, c)).toBe('present');
  });
  it('the bill counts it missing and still adds up the half it has', () => {
    const s = summarise({ start: k, end: '2026-10-26' }, byDay(gappy), cover);
    expect(s.missing).toBe(1);
    expect(s.kwh).toBeCloseTo(49 * 0.5);
  });
  it('the heatmap hatches it, and the day bar counts it', () => {
    const d = byDay(gappy);
    const c = cellOf(d, cover, null, null, k, 2);
    expect(c.hatch).toBe('bw');
    expect(c.value).toBeCloseTo(0.5);
    const cells = Array.from({ length: 48 }, (_, s) => cellOf(d, cover, null, null, k, s));
    expect(daySummary(cells).missImp).toBe(1);
  });
  it('with export there, a half-missing import is hatched red over the colour', () => {
    const exp = byDay(all.map((x) => ({ ...x, kwh: 0.1 })));
    const c = cellOf(byDay(gappy), cover, exp, cover, k, 2);
    expect(c.hatch).toBe('red');
    expect(c.value).toBeCloseTo(0.5 - 0.2);
  });
});

import { parseGasNode, gasUnit } from '../src/measurements.js';

describe('the gas heatmap', () => {
  const gasInfo = { number: 'A-0000ABC7', import: { mpan: '2600000000001', agreements: [], from: null }, export: null,
    gas: { mprn: '9000000000', agreements: [], from: null }, billing: null };
  const sep = { start: '2026-09-01', end: '2026-10-01' };
  const g = (kwh) => ({ start: midnight('2026-09-01'), kwh, unit: 'm³', costExc: null, standingExc: null, offPeak: null, split: null });
  const counting = () => {
    const o = { elec: 0, gas: 0,
      measurements: async () => { o.elec++; return []; },
      gasMeasurements: async (_n, mprn, from) => { o.gas++; expect(mprn).toBe('9000000000'); return from === '2026-09-01' ? [g(0.42)] : []; },
      measurementsBetween: async () => [], publishedRates: async () => [] };
    return o;
  };

  it('reads a gas node and its unit', () => {
    const iv = parseGasNode({ startAt: '2026-09-01T00:00:00+01:00', value: '0.420', unit: 'M3' });
    expect(iv).toMatchObject({ kwh: 0.42, unit: 'm³', costExc: null });
    expect([gasUnit('kWh'), gasUnit('m3'), gasUnit(null)]).toEqual(['kWh', 'm³', 'kWh']);
  });
  it('describeAccount finds the gas meter point', () => {
    const acc = { properties: [{ electricityMeterPoints: [{ mpan: '2600000000001', direction: 'IMPORT', agreements: [] }],
      gasMeterPoints: [{ mprn: '9000000000', agreements: [{ validFrom: '2025-01-01T00:00:00Z', validTo: null }] }] }] };
    expect(describeAccount('A-0000ABC7', acc).gas).toMatchObject({ mprn: '9000000000', from: '2025-01-01' });
    expect(describeAccount('A-0000ABC7', { properties: [{ electricityMeterPoints: [] }] }).gas).toBe(null);
  });
  it('loads a month’s gas with its electricity, in the reported unit', async () => {
    const o = counting();
    const d = new AccountData(o, gasInfo, null);
    await d.loadMonth(sep);
    expect(o.gas).toBeGreaterThan(0);
    expect(d.gasDays.get('2026-09-01').get(0).kwh).toBeCloseTo(0.42);
    expect(d.gasUnit).toBe('m³');
  });
  it('a month cached before gas was loaded asks Octopus for its gas only', async () => {
    const cache = memoryCache();
    const key = monthKey(gasInfo, sep);
    await cache.put(key, { shape: CACHE_SHAPE, fetchedAt: midnight('2026-12-01'), imp: [], exp: [], rates: [] });
    const o = counting();
    const d = new AccountData(o, gasInfo, cache);
    expect(await d.loadMonth(sep)).toBe('device');
    expect(o.elec).toBe(0);
    expect(o.gas).toBeGreaterThan(0);
    expect((await cache.get(key)).gas).toHaveLength(1);
    const again = counting();
    await new AccountData(again, gasInfo, cache).loadMonth(sep);
    expect(again.gas).toBe(0);
  });
  it('an account without gas asks for none', async () => {
    const o = counting();
    await new AccountData(o, { ...gasInfo, gas: null }, null).loadMonth(sep);
    expect(o.gas).toBe(0);
  });
  it('the day bar speaks of gas in its unit', () => {
    const d = { net: 12.5, imp: 12.5, exp: 0, missImp: 2, missExp: 0 };
    expect(dayBarText('2026-11-10', d, false, 'm³', 'gas')).toBe('Tue 10 Nov 2026 · 12.50 m³ · 2 gas half-hours missing');
  });
});

import { cardNotes } from '../src/bills.js';
import { inIogWindow as iogWin } from '../src/rates.js';

describe('the standing charge: the tariff’s daily rate', () => {
  const k = '2026-08-10', t = (s) => midnight(k) + s * HALF_HOUR;
  const cover = { from: '2026-01-01', last: midnight('2026-08-12'), now: midnight('2026-08-12') };
  const period = { start: k, end: addDays(k, 1) };
  // Octopus attaches a rounded share of the daily charge to each half-hour (made-up figures): 1.04p, so 49.92p a day
  const day = (n, per) => byDay(Array.from({ length: n }, (_, s) => ({ start: t(s), kwh: 0.1, costExc: 0.5, standingExc: per, offPeak: null, split: null })));

  it('a day whose half-hours sum to within rounding of the tariff’s rate is that rate', () => {
    const s = summarise(period, day(48, 1.04), cover, null, null, () => 0, { standingRate: () => 50.05 });
    expect(s.standingDays[k].exc).toBeCloseTo(50.05);
    expect(s.bill.standing).toEqual([{ days: 1, rateExc: 50.05, exc: 50 }]);
  });
  it('(guard) a real price change is kept: half-hours far from the tariff’s current rate', () => {
    const s = summarise(period, day(48, 0.95), cover, null, null, () => 0, { standingRate: () => 50.05 });
    expect(s.standingDays[k].exc).toBeCloseTo(45.6);
  });
  it('a finished day with standing on only some half-hours is scaled to the whole day', () => {
    const s = summarise(period, day(24, 1.04), cover, null, null, () => 0, {});
    expect(s.standingDays[k].exc).toBeCloseTo(49.92);
    const t2 = summarise(period, day(24, 1.04), cover, null, null, () => 0, { standingRate: () => 50.05 });
    expect(t2.standingDays[k].exc).toBeCloseTo(50.05);
  });
  it('(guard) today is not scaled: its half-hours have not all happened', () => {
    const now = { ...cover, now: midnight(k) + 24 * HALF_HOUR + 60000, last: midnight(k) + 23 * HALF_HOUR };
    const s = summarise(period, day(24, 1.04), now, null, null, () => 0, { standingRate: () => 50.05 });
    expect(s.standingDays[k].exc).toBeCloseTo(24.96);
  });
  it('the inc-VAT standing charge follows the corrected days', () => {
    const s = summarise(period, day(48, 1.04), cover, null, null, () => 0.05, { standingRate: () => 50.05 });
    expect(s.standing).toBeCloseTo(50.05 * 1.05);
  });
});

describe('half-hours Octopus never costed: estimated at the band’s rate', () => {
  const k = '2026-04-01', t = (s) => midnight(k) + s * HALF_HOUR;
  const cover = { from: '2026-01-01', last: midnight('2026-04-03'), now: midnight('2026-04-03') };
  const period = { start: k, end: addDays(k, 1) };
  const iv = (s, kwh, costExc, offPeak) => ({ start: t(s), kwh, costExc, standingExc: 0, offPeak, split: null });
  // off-peak 5p, peak 30p ex VAT (made-up); night half-hours 0–10 not costed by Octopus
  const ivs = [iv(0, 3, null, null), iv(1, 3, null, null), iv(20, 1, null, null),
    iv(30, 1, 30, false), iv(31, 1, 30, false), iv(47, 2, 10, true)];
  const opts = { offWindowOn: () => iogWin };

  it('a night half-hour takes the day’s off-peak rate, a day one the peak rate', () => {
    const s = summarise(period, byDay(ivs), cover, null, null, () => 0, opts);
    expect(s.estimatedKwh).toBeCloseTo(7);
    expect(s.estimatedSlots).toBe(3);
    expect(s.uncostedSlots).toBe(0);
    expect(s.offPeak.kwh).toBeCloseTo(2 + 6);
    expect(s.offPeak.exc).toBeCloseTo(10 + 6 * 5);
    expect(s.peak.exc).toBeCloseTo(60 + 30);
    expect(s.energyExc).toBeCloseTo(10 + 60 + 30 + 30);
  });
  it('with no rate to go by, it stays uncosted, as before', () => {
    const s = summarise(period, byDay([iv(0, 3, null, null)]), cover, null, null, () => 0, opts);
    expect(s.estimatedSlots).toBe(0);
    expect(s.uncostedSlots).toBe(1);
    expect(s.energyExc).toBe(0);
  });
  it('a day with no costed half-hours borrows the period’s band rate', () => {
    const k2 = '2026-04-02', t2 = (s) => midnight(k2) + s * HALF_HOUR;
    const more = [...ivs, { start: t2(2), kwh: 4, costExc: null, standingExc: 0, offPeak: null, split: null }];
    const s = summarise({ start: k, end: addDays(k2, 1) }, byDay(more), cover, null, null, () => 0, opts);
    expect(s.estimatedKwh).toBeCloseTo(11);
    expect(s.offPeak.exc).toBeCloseTo(10 + 6 * 5 + 4 * 5);
  });
});

describe('the bill card’s notes', () => {
  const base = { missing: 0, uncostedSlots: 0, uncostedKwh: 0, unsplitSlots: 0, split: null, pending: 0, exportMissing: 0, estimatedSlots: 0, estimatedKwh: 0 };
  it('warns when export readings are missing, as it does for import', () => {
    const n = cardNotes({ ...base, exportMissing: 120 });
    expect(n.some((x) => x.cls === 'warn' && /120 export half-hours with no reading.*export credit will look short/.test(x.text))).toBe(true);
  });
  it('says how much it estimated', () => {
    const n = cardNotes({ ...base, estimatedSlots: 9, estimatedKwh: 31.5 });
    expect(n.some((x) => x.cls === 'warn' && /31\.50 kWh in 9 half-hours Octopus has not costed: estimated at that band’s rate/.test(x.text))).toBe(true);
  });
  it('says nothing about export when none is missing', () => {
    expect(cardNotes(base).some((x) => /export/.test(x.text))).toBe(false);
  });
});

describe('an estimate’s band: what Octopus charged at that time of day in the bill', () => {
  const cover = { from: '2026-01-01', last: midnight('2026-04-10'), now: midnight('2026-04-10') };
  const at = (k, s, kwh, costExc, offPeak) => ({ start: midnight(k) + s * HALF_HOUR, kwh, costExc, standingExc: 0, offPeak, split: null });
  // On 1–4 April Octopus charged 05:30 (slot 11, just outside 23:30–05:30) at off-peak: charging ran on.
  const costed = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04'].flatMap((k) => [at(k, 11, 2, 10, true), at(k, 30, 1, 30, false)]);
  it('a 05:30 half-hour Octopus mostly charged at off-peak is estimated at off-peak', () => {
    const ivs = [...costed, at('2026-04-05', 11, 2, null, null)];
    const s = summarise({ start: '2026-04-01', end: '2026-04-06' }, byDay(ivs), cover, null, null, () => 0, { offWindowOn: () => iogWin });
    expect(s.estimatedSlots).toBe(1);
    expect(s.offPeak.exc).toBeCloseTo(4 * 10 + 2 * 5);
  });
  it('(guard) with no history at that time, the window decides', () => {
    const ivs = [...costed, at('2026-04-05', 20, 1, null, null)];
    const s = summarise({ start: '2026-04-01', end: '2026-04-06' }, byDay(ivs), cover, null, null, () => 0, { offWindowOn: () => iogWin });
    expect(s.peak.exc).toBeCloseTo(4 * 30 + 30);
  });
});

import { awaitingCost } from '../src/rates.js';
import { awaitingText, ARRIVING_DAYS } from '../src/bills.js';

describe('a day whose costs are still arriving', () => {
  const day = new Map([
    [0, { kwh: 1.2, costExc: 6 }],          // costed
    [1, { kwh: 0.8, costExc: null }],       // kWh in, cost not yet
    [2, { kwh: 0.0001, costExc: null }],    // noise: no kWh to cost
    [3, { kwh: 2.5, costExc: null }],
  ]);
  it('finds the half-hours with kWh but no cost', () => {
    expect([...awaitingCost(day, [0, 1, 2, 3, 4])]).toEqual([1, 3]);
    expect(awaitingCost(undefined, [0, 1]).size).toBe(0);
  });
  it('says the costs are still arriving within a week of the day', () => {
    const t = awaitingText('2026-11-25', 2, 3.3, '2026-11-26');
    expect(t.label).toBe('Costs still arriving');
    expect(t.note).toMatch(/2 half-hours \(3\.30 kWh\)/);
    expect(awaitingText('2026-11-19', 1, 1, '2026-11-26').head).toBe('costs still arriving');
  });
  it('says an older day was not costed, and is estimated', () => {
    const t = awaitingText('2026-11-18', 1, 0.8, '2026-11-26');
    expect(ARRIVING_DAYS).toBe(7);
    expect(t.label).toBe('Not costed by Octopus');
    expect(t.note).toMatch(/1 half-hour \(0\.80 kWh\).*estimates/);
  });
  it('says nothing when every half-hour is costed', () => {
    expect(awaitingText('2026-11-25', 0, 0, '2026-11-26')).toBe(null);
  });
});

import { dayNote } from '../src/bills.js';
import { provisionalMonths, PROVISIONAL_DAYS } from '../src/data.js';

describe('provisional days', () => {
  it('today and the 3 days before it are provisional; the 4th day back is not', () => {
    expect(PROVISIONAL_DAYS).toBe(3);
    expect(dayNote('2026-11-26', 0, 0, '2026-11-26').text).toMatch(/^Today so far/);
    expect(dayNote('2026-11-25', 0, 0, '2026-11-26').head).toBe('provisional');
    expect(dayNote('2026-11-23', 0, 0, '2026-11-26').head).toBe('provisional');
    expect(dayNote('2026-11-22', 0, 0, '2026-11-26')).toBe(null);
  });
  it('costs still arriving take the place of the provisional note', () => {
    expect(dayNote('2026-11-25', 2, 3.3, '2026-11-26').head).toBe('costs still arriving');
    expect(dayNote('2026-11-10', 1, 0.8, '2026-11-26').head).toBe('1 not costed');
  });
  it('a refresh asks for the months holding today or a provisional day, if loaded', () => {
    const loaded = ['2026-12-01', '2026-11-01', '2026-10-01'];
    expect(provisionalMonths(loaded, '2026-12-15').map((m) => m.start)).toEqual(['2026-12-01']);
    expect(provisionalMonths(loaded, '2026-12-02').map((m) => m.start)).toEqual(['2026-12-01', '2026-11-01']);
    expect(provisionalMonths(['2026-11-01'], '2026-12-02').map((m) => m.start)).toEqual(['2026-11-01']);
  });
});

describe('refreshing a month', () => {
  const info = { number: 'A-0000ABC7', import: { mpan: '2600000000001', agreements: [], from: null }, export: null, billing: null };
  const nov = { start: '2026-11-01', end: '2026-12-01' };
  const t = midnight('2026-11-25') + 37 * HALF_HOUR;   // 18:30
  const octoWith = (costExc, offPeak) => ({
    measurements: async (_a, _m, from) => (from === '2026-11-21' ? [{ start: t, kwh: 2.4, costExc, standingExc: 1, offPeak, split: null }] : []),
    measurementsBetween: async () => [], publishedRates: async () => [] });
  it('puts Octopus’s new answer in place of the old, not beside it', async () => {
    const cache = memoryCache();
    const d = new AccountData(octoWith(73.8, false), info, cache);   // first answer: peak
    await d.loadMonth(nov);
    d.octo = octoWith(12.5, true);                                   // re-priced: off-peak
    await d.refreshMonth(nov);
    expect(d.imp.length).toBe(1);
    expect(d.impDays.get('2026-11-25').get(37)).toMatchObject({ costExc: 12.5, offPeak: true });
    expect(d.loaded).toEqual(['2026-11-01']);
    expect((await cache.get(monthKey(info, nov))).imp[0].costExc).toBe(12.5);
  });
});

import { statementKwh } from '../src/bill.js';
import { agileOn, isAgile } from '../src/data.js';

// EMT's tests/test_agile_statement_kwh.py, ported (26 Nov 2026): an Agile statement prices each
// half-hour at its rate × its kWh to 0.01, half to even. The same made-up half-hours, so the
// figures are EMT's.
describe('an Agile statement’s kWh', () => {
  const AGILE_IN = { productCode: 'AGILE-24-10-01', tariffCode: 'E-1R-AGILE-24-10-01-A' };
  const AGILE_OUT = { productCode: 'AGILE-OUTGOING-19-05-13', tariffCode: 'E-1R-AGILE-OUTGOING-19-05-13-A' };
  const INTELLI = { productCode: 'INTELLI-VAR-22-10-14', tariffCode: 'E-1R-INTELLI-VAR-22-10-14-A' };
  const FIX_OUT = { productCode: 'OUTGOING-FIX-12M-19-05-13', tariffCode: 'E-1R-OUTGOING-FIX-12M-19-05-13-A' };
  const ag = (tariff, validFrom, validTo = null) => ({ tariff, validFrom, validTo });
  // 5 Sep 2026 (BST), five half-hours from 12:00 local: [imp kWh, imp p/kWh ex VAT, exp kWh, exp p/kWh]
  const HH = [[0.004, 30, 0.005, 15], [0.005, 30, 0.015, 15], [0.015, 10, 0.0125, 15], [1.945, 20, 2.0, 15], [0.333, -5, 0, 15]];
  const t0 = Date.parse('2026-09-05T11:00:00Z');
  const ivs = (dir) => HH.map(([k, r, ek, er], i) => (dir === 'imp'
    ? { start: t0 + i * HALF_HOUR, kwh: k, costExc: k * r, standingExc: null, offPeak: null, split: null }
    : { start: t0 + i * HALF_HOUR, kwh: ek, costExc: -ek * er, standingExc: null, offPeak: null, split: null }));
  const cover = { from: '2026-09-05', last: t0 + 4 * HALF_HOUR, now: Date.parse('2026-09-06T12:00:00Z') };
  const card = (imp, exp) => summarise({ start: '2026-09-05', end: '2026-09-06' }, byDay(ivs('imp')), cover,
    byDay(ivs('exp')), cover, () => 0.05, { agileImport: agileOn(imp), agileExport: agileOn(exp) });
  const AGILE = [[ag(AGILE_IN, '2026-02-15T00:00:00Z')], [ag(AGILE_OUT, '2026-01-01T00:00:00Z')]];

  it('rounds to 0.01 kWh, half to even', () => {
    expect([0.004, 0.005, 0.0050000000001, 0.006, 0.015, 0.025, 1.945, 0.0125, 0].map(statementKwh))
      .toEqual([0, 0, 0, 0.01, 0.02, 0.02, 1.94, 0.01, 0]);
  });
  it('takes Agile and Agile Outgoing only, and only while their agreement is in force', () => {
    expect([AGILE_IN, AGILE_OUT, INTELLI, FIX_OUT].map(isAgile)).toEqual([true, true, false, false]);
    expect(agileOn([ag(FIX_OUT, '2026-01-01T00:00:00Z')])).toBe(null);
    const on = agileOn([ag(INTELLI, '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z'), ag(AGILE_IN, '2026-03-01T00:00:00Z')]);
    expect([on(Date.parse('2026-02-28T23:30:00Z')), on(Date.parse('2026-03-01T00:00:00Z'))]).toEqual([false, true]);
  });
  it('prices Agile import at the statement’s kWh', () => {
    const s = card(...AGILE);
    expect(s.billKwh).toBeCloseTo(2.29, 9);          // 0 + 0 + 0.02 + 1.94 + 0.33; the meter 2.302
    expect(s.kwh).toBeCloseTo(2.302, 9);             // what the heatmap and charts show
    expect(s.energyExc).toBeCloseTo(37.35, 9);       // 0.02 × 10 + 1.94 × 20 + 0.33 × −5 (the meter's 37.655)
    expect(s.bill.energyExc).toBeCloseTo(37, 9);
  });
  it('credits Agile Outgoing export at the statement’s kWh', () => {
    const s = card(...AGILE);
    expect(s.billExportKwh).toBeCloseTo(2.03, 9);    // 0 + 0.02 + 0.01 + 2.00; the meter 2.0325
    expect(s.exportCredit).toBeCloseTo(30.45, 9);
    expect(s.agileSlots).toBe(10);                   // five import, five export (a 0 kWh reading is still on Agile)
  });
  it('GUARD: Intelligent is summed as Octopus costed it', () => {
    const s = card([ag(INTELLI, '2026-02-15T00:00:00Z')], []);
    expect(s.billKwh).toBeCloseTo(2.302, 9);
    expect(s.energyExc).toBeCloseTo(37.655, 9);
    expect(s.billExportKwh).toBeCloseTo(2.0325, 9);
    expect(s.agileSlots).toBe(0);
  });
  it('rounds only the half-hours on Agile', () => {
    // Agile from 12:30 local: the first half-hour keeps its 0.004
    const s = card([ag(INTELLI, '2026-02-15T00:00:00Z', '2026-09-05T11:30:00Z'), ag(AGILE_IN, '2026-09-05T11:30:00Z')], []);
    expect(s.billKwh).toBeCloseTo(2.294, 9);
  });
  it('rounds each of a clocks-back half-hour’s two readings', () => {
    // 25 Oct 2026: 01:00 BST (00:00Z) and 01:00 GMT (01:00Z) share slot 2
    const two = [0, 1].map((h) => ({ start: Date.parse(`2026-10-25T0${h}:00:00Z`), kwh: 0.006, costExc: 0.006 * 20, standingExc: null, offPeak: null, split: null }));
    const c = { from: '2026-10-25', last: two[1].start, now: Date.parse('2026-10-26T12:00:00Z') };
    const s = summarise({ start: '2026-10-25', end: '2026-10-26' }, byDay(two), c, null, null, () => 0,
      { agileImport: agileOn(AGILE[0]) });
    expect(s.billKwh).toBeCloseTo(0.02, 9);          // 0.01 + 0.01; the slot's 0.012 would round to 0.01
    expect(s.energyExc).toBeCloseTo(0.4, 9);
  });
});

describe('the card’s Agile note', () => {
  const base = { missing: 0, exportMissing: 0, estimatedSlots: 0, uncostedSlots: 0, unsplitSlots: 0, split: null, pending: 0 };
  it('says the statement’s rounding applies, and what the meter read when it moved the kWh', () => {
    const [n] = cardNotes({ ...base, agileSlots: 9, kwh: 2.302, billKwh: 2.29, exportKwh: 2.0325, billExportKwh: 2.03 });
    expect(n.text).toMatch(/^Agile: .*rounded to 0\.01 \(the meter read 2\.30 kWh imported, 2\.03 kWh exported\)/);
    const [m] = cardNotes({ ...base, agileSlots: 2, kwh: 1.5, billKwh: 1.5, exportKwh: 0, billExportKwh: 0 });
    expect(m.text).not.toMatch(/meter read/);
  });
  it('GUARD: says nothing off Agile', () => {
    expect(cardNotes({ ...base, agileSlots: 0 }).length).toBe(0);
  });
});

import { readFileSync } from 'node:fs';
import { sections, problems, unwrap } from '../scripts/changelog.js';

describe('the changelog', () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  it('has a dated section for the version in package.json, straight after Unreleased', () => {
    expect(problems(text, version)).toEqual([]);
  });
  it('dates every released section, newest first', () => {
    const rel = sections(text).slice(1);
    expect(rel.every((s) => /^\d{4}\.\d{1,2}\.\d+$/.test(s.version) && s.date)).toBe(true);
    const n = (v) => v.split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
    expect(rel.map((s) => n(s.version))).toEqual(rel.map((s) => n(s.version)).sort((a, b) => b - a));
  });
  it('says what is missing for a version not yet released', () => {
    const t = '# C\n\n## [Unreleased]\n\n- a thing\n\n## [2026.11.5] — 2026-11-26\n\n- b\n\n[2026.11.5]: x\n';
    expect(problems(t, '2026.11.5')).toEqual([]);
    expect(problems(t, '2026.11.6')).toEqual(['no section for 2026.11.6', 'no link for [2026.11.6] at the end']);
    expect(problems(t.replace(' — 2026-11-26', ''), '2026.11.5')).toEqual(['2026.11.5 has no date ("## [2026.11.5] — YYYY-MM-DD")']);
  });
  it('joins wrapped lines for a GitHub release, keeping bullets and paragraphs apart', () => {
    expect(unwrap('Intro that\nwraps.\n\n- **One** that\n  wraps\n- Two')).toBe('Intro that wraps.\n\n- **One** that wraps\n- Two');
  });
});

import { releaseProblems } from '../scripts/changelog.js';

describe('a release pull request’s changelog', () => {
  const ok = '# C\n\n## [Unreleased]\n\n## [2026.11.6] — 2026-11-27\n\n- new\n\n## [2026.11.5] — 2026-11-26\n\n- b\n\n[2026.11.6]: x\n[2026.11.5]: y\n';
  it('passes with the version bumped, dated, and Unreleased emptied into it', () => {
    expect(releaseProblems(ok, '2026.11.6', '2026.11.5')).toEqual([]);
    expect(releaseProblems(ok, '2026.11.6', '2026.10.9')).toEqual([]);
  });
  it('fails a version not bumped, or notes left under Unreleased', () => {
    expect(releaseProblems(ok, '2026.11.6', '2026.11.6')).toEqual(["the version 2026.11.6 is not after main's 2026.11.6: bump it in package.json"]);
    expect(releaseProblems(ok.replace('## [Unreleased]\n', '## [Unreleased]\n\n- left behind\n'), '2026.11.6', '2026.11.5'))
      .toEqual(['[Unreleased] still has notes: move them under the new version']);
  });
});

import { prepare } from '../scripts/changelog.js';

describe('preparing a release', () => {
  const t = '# C\n\n## [Unreleased]\n\n- new thing\n\n## [2026.11.5] — 2026-11-26\n\n- b\n\n'
    + '[Unreleased]: https://github.com/RGx01/EMT-lite/compare/v2026.11.5...dev\n[2026.11.5]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.5\n';
  it('moves Unreleased under the version, dated, and links it', () => {
    const out = prepare(t, '2026.11.6', '2026-11-27');
    expect(releaseProblems(out, '2026.11.6', '2026.11.5')).toEqual([]);
    expect(sections(out).map((x) => [x.version, x.date, x.body])).toEqual([
      ['Unreleased', null, ''], ['2026.11.6', '2026-11-27', '- new thing'], ['2026.11.5', '2026-11-26', '- b']]);
    expect(out).toMatch(/^\[Unreleased\]: .*compare\/v2026\.11\.6\.\.\.dev$/m);
    expect(out).toMatch(/^\[2026\.11\.6\]: .*releases\/tag\/v2026\.11\.6$/m);
  });
  it('refuses an empty Unreleased, or a version already there', () => {
    expect(() => prepare(prepare(t, '2026.11.6', '2026-11-27'), '2026.11.7', '2026-11-28')).toThrow(/no notes/);
    expect(() => prepare(t, '2026.11.5', '2026-11-27')).toThrow(/already/);
  });
});

import { isDark, toggleTheme } from '../src/theme.js';
import { vi, afterEach } from 'vitest';

describe('theme: EMT\'s logo switches light / dark', () => {
  afterEach(() => vi.unstubAllGlobals());
  const root = (theme) => ({ dataset: theme ? { theme } : {} });
  const device = (dark) => vi.stubGlobal('matchMedia', () => ({ matches: dark }));

  it('follows the device until a choice is made', () => {
    device(true); expect(isDark(root())).toBe(true);
    device(false); expect(isDark(root())).toBe(false);
  });
  it('a choice overrides the device', () => {
    device(true); expect(isDark(root('light'))).toBe(false);
    device(false); expect(isDark(root('dark'))).toBe(true);
  });
  it('a click flips from what is shown, and keeps the choice', () => {
    const stored = {};
    vi.stubGlobal('localStorage', { setItem: (k, v) => { stored[k] = v; } });
    device(true);
    const r = root();
    expect(toggleTheme(r)).toBe('light');
    expect(r.dataset.theme).toBe('light');
    expect(stored.emt_lite_theme).toBe('light');
    expect(toggleTheme(r)).toBe('dark');
    expect(stored.emt_lite_theme).toBe('dark');
  });
  it('blocked storage still switches, for the visit', () => {
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('blocked'); } });
    device(false);
    const r = root();
    expect(toggleTheme(r)).toBe('dark');
    expect(r.dataset.theme).toBe('dark');
  });
});

import { dayHeadText } from '../src/bills.js';

describe('the figures beside a day', () => {
  // A fictional IOG-SMB day after 1 Oct (0% VAT): a split night, a split peak half-hour, and one
  // half-hour Octopus has costed but not split yet. Three half-hours carry 1p of standing charge
  // each: a finished day is scaled to 48 of them, 48p.
  const t = (slot) => midnight('2026-11-10') + slot * HALF_HOUR;
  const imp = byDay([
    { start: t(2), kwh: 4, costExc: 28, standingExc: 1, offPeak: true,
      split: { 'ev:off': { kwh: 3.5, cost: 24 }, 'home:off': { kwh: 0.5, cost: 4 } } },
    { start: t(20), kwh: 0.4, costExc: 9.8, standingExc: 1, offPeak: false,
      split: { 'home:peak': { kwh: 0.4, cost: 9.8 } } },
    { start: t(30), kwh: 0.6, costExc: 14.7, standingExc: 1, offPeak: false, split: null },
  ]);
  const cover = { from: '2026-01-01', last: midnight('2026-11-11'), now: midnight('2026-11-12') };
  const day = { start: '2026-11-10', end: '2026-11-11' };
  it('an IOG-SMB day shows the House and EV buckets, the half-hours not split yet and the standing charge', () => {
    const s = summarise(day, imp, cover);
    const text = dayHeadText(s, false);
    expect(text).toMatch(/^5\.00 kWh · £1\.0\d \(/);
    expect(text).toContain('House 0.90 kWh £0.14');        // 4p + 9.8p
    expect(text).toContain('EV 3.50 kWh £0.24');
    expect(text).toContain('not split yet 0.60 kWh £0.15'); // 14.7p
    expect(text).toContain('standing £0.48');
    expect(text).not.toContain('Export');
  });
  it('a day without a split keeps the kWh and cost alone', () => {
    const plain = byDay([{ start: t(2), kwh: 4, costExc: 28, standingExc: null, offPeak: true, split: null }]);
    expect(dayHeadText(summarise(day, plain, cover), false)).toBe('4.00 kWh · £0.28');
  });
  it('an export meter adds its kWh and credit, which the import total leaves out', () => {
    const exp = byDay([{ start: t(26), kwh: 2, costExc: 30, standingExc: null, offPeak: false }]);
    const s = summarise(day, imp, cover, exp, cover);
    expect(dayHeadText(s, true)).toMatch(/^5\.00 kWh · £1\.0\d .* · Export 2\.00 kWh −£0\.30$/);
    const none = summarise(day, imp, cover, byDay([]), cover);
    expect(dayHeadText(none, true)).toMatch(/ · Export 0\.00 kWh £0\.00$/);
  });
});

import { hoverLabel } from '../src/bills.js';

describe('the day chart hover', () => {
  // fictional figures
  it('a costed bar shows its kWh, then its cost in pence', () => {
    const d = { label: 'EV off-peak', yAxisID: 'kwh', _cost: [null, 24.5] };
    expect(hoverLabel(d, 1, 3.5)).toBe('EV off-peak: 3.500 kWh (24.50p)');
  });
  it('a half-hour without a cost shows its kWh alone', () => {
    const d = { label: 'Costs still arriving', yAxisID: 'kwh' };
    expect(hoverLabel(d, 0, 0.8)).toBe('Costs still arriving: 0.800 kWh');
    expect(hoverLabel({ label: 'Import peak', yAxisID: 'kwh', _cost: [null] }, 0, 0.8)).toBe('Import peak: 0.800 kWh');
  });
  it('export is drawn below zero and shown as a credit', () => {
    const d = { label: 'Export', yAxisID: 'kwh', _cost: [15], _credit: true };
    expect(hoverLabel(d, 0, -2)).toBe('Export: 2.000 kWh (15.00p credit)');
  });
  it('a rate stays p/kWh, and an empty point has no line', () => {
    expect(hoverLabel({ label: 'Rate p/kWh', yAxisID: 'rate' }, 0, 7.35)).toBe('Rate p/kWh: 7.35');
    expect(hoverLabel({ label: 'Import peak', yAxisID: 'kwh' }, 0, null)).toBe(null);
  });
});
