// Loading an account (design §5): who, which meters, the billing day, then the half-hours a month
// at a time, newest first. Everything is held in memory; nothing is stored here.

import { recoverCosts } from './octopus.js';
import { byDay } from './measurements.js';
import { anchorFromBillingDay } from './periods.js';
import { addMonths, addDays, parseKey, todayKey, dayKeyOf, midnight, HALF_HOUR, slotOf } from './time.js';

export const DEFAULT_MONTHS = 13;

const dateKey = (iso) => (iso ? dayKeyOf(Date.parse(iso)) : null);

function isExportPoint(mp) {
  if (String(mp.direction || '').toUpperCase() === 'EXPORT') return true;
  if (String(mp.direction || '').toUpperCase() === 'IMPORT') return false;
  return (mp.agreements || []).some((a) => a.tariff?.isExport);
}

/** The agreement in force at `ms`: valid, and not a zero-length blip (EMT v5 #53). */
export function agreementAt(agreements, ms) {
  return (agreements || []).find((a) => {
    const f = a.validFrom ? Date.parse(a.validFrom) : -Infinity;
    const t = a.validTo ? Date.parse(a.validTo) : Infinity;
    return t > f && f <= ms && ms < t;
  }) || null;
}

function meterOf(mp) {
  const ags = (mp.agreements || []).slice().sort((a, b) => String(a.validFrom).localeCompare(String(b.validFrom)));
  return { mpan: mp.mpan, agreements: ags, from: dateKey(ags[0]?.validFrom) };
}

/** Pick meters and the billing rule from Octopus's account answer. Pure. */
export function describeAccount(number, acc, today = todayKey()) {
  const points = (acc?.properties || []).flatMap((p) => p.electricityMeterPoints || []);
  const now = Date.now();
  const live = (mp) => !!agreementAt(mp.agreements, now);
  const imports = points.filter((mp) => !isExportPoint(mp));
  const exports = points.filter(isExportPoint);
  const pick = (list) => list.find(live) || list[0] || null;
  const imp = pick(imports), exp = pick(exports);

  // The billing day (design §5.2): Octopus's periodStartDay. currentBillingPeriodStartDate is
  // not used: on the first real account it was the statement cycle's date, not the billing day.
  const bo = acc?.billingOptions || {};
  const months = (String(bo.periodLength || 'MONTHLY').toUpperCase() === 'QUARTERLY' ? 3 : 1)
    * Math.max(1, Number(bo.periodLengthMultiplier) || 1);
  const billing = bo.periodStartDay ? billingFromDay(bo.periodStartDay, 'octopus', today, months) : null;
  return { number, import: imp && meterOf(imp), export: exp && meterOf(exp), billing };
}

export const DEFAULT_BILLING_DAY = 1;

export function billingFromDay(day, source, today = todayKey(), months = 1) {
  const d = Math.max(1, Math.min(31, Math.round(Number(day)) || DEFAULT_BILLING_DAY));
  return { day: d, anchor: anchorFromBillingDay(d, today), months, source };
}

/** A monthly trigger day from Kraken's billing trigger configuration, or null. */
export function triggerDay(trigger) {
  if (!trigger || trigger.error || trigger.isActive === false) return null;
  const f = (trigger.operationFrequencies || []).find((o) => /MONTH/i.test(String(o.frequency || ''))
    && Number(o.multiplier || 1) === 1 && Number(o.triggerAtStartDay) >= 1);
  return f ? Number(f.triggerAtStartDay) : null;
}

/**
 * The billing rule, in order: a day the user chose; Octopus's periodStartDay; Kraken's monthly
 * billing trigger day; the 1st. Pure.
 */
export function chooseBilling({ userDay = null, info = null, trigger = null, today = todayKey() }) {
  if (userDay) return billingFromDay(userDay, 'user', today);
  if (info?.billing) return info.billing;
  const t = triggerDay(trigger);
  if (t) return billingFromDay(t, 'trigger', today);
  return billingFromDay(DEFAULT_BILLING_DAY, 'default', today);
}

/** The local months to load, newest first: `count` months ending with this one. */
export function monthsToLoad(count, today = todayKey()) {
  const { y, m } = parseKey(today);
  const out = [];
  for (let i = 0; i < count; i++) {
    const start = addMonths(y, m, 1, -i);
    const s = parseKey(start);
    out.push({ start, end: addMonths(s.y, s.m, 1, 1) });
  }
  return out;
}

export class AccountData {
  constructor(octo, info) {
    this.octo = octo;
    this.info = info;
    this.imp = [];
    this.exp = [];
    this.published = new Map();   // slot start ms → p/kWh exc VAT (Agile)
    this.loaded = [];             // month starts loaded
    this._rebuild();
  }

  _rebuild() {
    this.impDays = byDay(this.imp);
    this.expDays = this.info.export ? byDay(this.exp) : null;
    const lastOf = (ivs) => ivs.reduce((mx, iv) => Math.max(mx, iv.start), -Infinity);
    const li = lastOf(this.imp), le = lastOf(this.exp);
    this.impCover = { from: this.info.import?.from || null, last: Number.isFinite(li) ? li : null };
    this.expCover = { from: this.info.export?.from || null, last: Number.isFinite(le) ? le : null };
  }

  /** Published rates for one day as Map<slot, p exc VAT>, or null. */
  publishedFor(dayKey) {
    if (!this.published.size) return null;
    const out = new Map();
    const end = midnight(addDays(dayKey, 1));
    for (let t = midnight(dayKey); t < end; t += HALF_HOUR) {
      const r = this.published.get(t);
      if (r != null) out.set(slotOf(t), r);
    }
    return out.size ? out : null;
  }

  // Import and export are asked for at the same time: Octopus takes seconds over each page of a
  // month (about 5 s for an IOG-SMB import page), and the two do not depend on each other.
  async loadMonth(month) {
    const { number } = this.info;
    const imp = this.info.import;
    const importing = imp ? (async () => {
      const got = await this.octo.measurements(number, imp.mpan, month.start, month.end, 'CONSUMPTION');
      await recoverCosts(this.octo, number, imp.mpan, got, 'CONSUMPTION', dayKeyOf, Date.now(), imp.from);
      const ag = agreementAt(imp.agreements, midnight(month.start) + 15 * 86400000);
      const t = ag?.tariff;
      const rates = t?.productCode && /AGILE/i.test(t.productCode)
        ? await this.octo.publishedRates(t.productCode, t.tariffCode, month.start, month.end) : [];
      return { got, rates };
    })() : Promise.resolve(null);
    const exporting = this.info.export
      ? this.octo.measurements(number, this.info.export.mpan, month.start, month.end, 'GENERATION')
      : Promise.resolve(null);
    const [i, e] = await Promise.all([importing, exporting]);
    // nothing is added until the whole month is in, so a month is never half shown
    if (i) {
      this.imp.push(...i.got);
      for (const r of i.rates) {
        for (let s = r.from; s < Math.min(r.to, midnight(month.end)); s += HALF_HOUR) this.published.set(s, r.exc);
      }
    }
    if (e) this.exp.push(...e);
    this.loaded.push(month.start);
    this._rebuild();
  }

  /** The months to show: the unbroken run of loaded months back from this one. Months load
   *  several at a time, so a later one can arrive first; it waits until those between are in,
   *  rather than showing them as gaps. Newest first. */
  shownMonths(today = todayKey()) {
    const out = [];
    for (const m of monthsToLoad(this.loaded.length, today)) {
      if (!this.loaded.includes(m.start)) break;
      out.push(m);
    }
    return out;
  }

  firstDay() {
    return this.shownMonths().at(-1)?.start || todayKey();
  }
}
