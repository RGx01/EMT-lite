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

import { solid, sideRateLine } from '../src/rates.js';

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


import { memoryCache, reusable, SETTLE_DAYS, CACHE_SHAPE } from '../src/cache.js';

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
