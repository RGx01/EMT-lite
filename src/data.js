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

  const bo = acc?.billingOptions || {};
  const months = (String(bo.periodLength || 'MONTHLY').toUpperCase() === 'QUARTERLY' ? 3 : 1)
    * Math.max(1, Number(bo.periodLengthMultiplier) || 1);
  let billing = null;
  if (bo.currentBillingPeriodStartDate) {
    billing = { anchor: bo.currentBillingPeriodStartDate, months, source: 'octopus' };
  } else if (bo.periodStartDay) {
    billing = { anchor: anchorFromBillingDay(bo.periodStartDay, today), months, source: 'octopus' };
  }
  return { number, import: imp && meterOf(imp), export: exp && meterOf(exp), billing };
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

  async loadMonth(month, onProgress = () => {}) {
    const { number } = this.info;
    const imp = this.info.import;
    if (imp) {
      onProgress(`Import ${month.start.slice(0, 7)}`);
      const got = await this.octo.measurements(number, imp.mpan, month.start, month.end, 'CONSUMPTION');
      await recoverCosts(this.octo, number, imp.mpan, got, 'CONSUMPTION', dayKeyOf);
      this.imp.push(...got);
      const ag = agreementAt(imp.agreements, midnight(month.start) + 15 * 86400000);
      const t = ag?.tariff;
      if (t?.productCode && /AGILE/i.test(t.productCode)) {
        onProgress(`Agile rates ${month.start.slice(0, 7)}`);
        for (const r of await this.octo.publishedRates(t.productCode, t.tariffCode, month.start, month.end)) {
          for (let s = r.from; s < Math.min(r.to, midnight(month.end)); s += HALF_HOUR) this.published.set(s, r.exc);
        }
      }
    }
    if (this.info.export) {
      onProgress(`Export ${month.start.slice(0, 7)}`);
      const got = await this.octo.measurements(number, this.info.export.mpan, month.start, month.end, 'GENERATION');
      this.exp.push(...got);
    }
    this.loaded.push(month.start);
    this._rebuild();
  }

  firstDay() {
    const s = [...this.loaded].sort()[0];
    return s || todayKey();
  }
}
