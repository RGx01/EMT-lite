// Loading an account (design §5): who, which meters, the billing day, then the half-hours a month
// at a time, newest first. Everything is held in memory; nothing is stored here.

import { recoverCosts } from './octopus.js';
import { reusable, monthKey, CACHE_SHAPE } from './cache.js';
import { byDay } from './measurements.js';
import { anchorFromBillingDay } from './periods.js';
import { statutoryRate } from './vat.js';
import { addMonths, addDays, parseKey, todayKey, dayKeyOf, midnight, HALF_HOUR, slotOf, dayWindows } from './time.js';

export const DEFAULT_MONTHS = 13;
// At most 482 half-hours (a clocks-back day has 50): one 500-row page of measurements.
export const WINDOW_DAYS = 10;

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

/** The default for a business account whose tariff does not show its VAT: the standard rate. */
export const BUSINESS_VAT_DEFAULT = 0.2;

/**
 * The account's VAT (design §5.3). Domestic: the calendar (vat.js). Business (Kraken's
 * `accountType` BUSINESS…): the rate its import tariff carries, standing charge inc VAT ÷ ex VAT,
 * from the agreement in force now (else the latest), snapped to a statutory rate; 20% if no tariff
 * shows one. One rate throughout: business VAT on electricity has not changed in the years loaded.
 */
export function accountVat(accountType, agreements, now = Date.now()) {
  if (!/^BUSINESS/i.test(String(accountType || ''))) return { business: false, rate: null, source: 'calendar' };
  const ags = [agreementAt(agreements, now), ...(agreements || []).slice().reverse()].filter(Boolean);
  for (const a of ags) {
    const inc = Number(a.tariff?.standingCharge), exc = Number(a.tariff?.preVatStandingCharge);
    const r = exc > 0 && inc > 0 ? statutoryRate(inc / exc - 1) : null;
    if (r != null) return { business: true, rate: r, source: 'tariff' };
  }
  return { business: true, rate: BUSINESS_VAT_DEFAULT, source: 'default' };
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
  // Gas (the gas heatmap only): the meter point with an agreement in force, else the first.
  const gasPoints = (acc?.properties || []).flatMap((p) => p.gasMeterPoints || []).filter((g) => g?.mprn);
  const gp = gasPoints.find(live) || gasPoints[0] || null;
  const gas = gp ? (() => {
    const ags = (gp.agreements || []).slice().sort((a, b) => String(a.validFrom).localeCompare(String(b.validFrom)));
    return { mprn: gp.mprn, agreements: ags, from: dateKey(ags[0]?.validFrom) };
  })() : null;

  // The billing day (design §5.2): Octopus's periodStartDay. currentBillingPeriodStartDate is
  // not used: on the first real account it was the statement cycle's date, not the billing day.
  const bo = acc?.billingOptions || {};
  const months = (String(bo.periodLength || 'MONTHLY').toUpperCase() === 'QUARTERLY' ? 3 : 1)
    * Math.max(1, Number(bo.periodLengthMultiplier) || 1);
  const billing = bo.periodStartDay ? billingFromDay(bo.periodStartDay, 'octopus', today, months) : null;
  const vat = accountVat(acc?.accountType, imp ? meterOf(imp).agreements : [], now);
  return { number, import: imp && meterOf(imp), export: exp && meterOf(exp), gas, billing, vat };
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
  constructor(octo, info, cache = null) {
    this.octo = octo;
    this.info = info;
    this.cache = cache;           // the device cache (design §6), or null: Remember me off, or the demo
    this.imp = [];
    this.exp = [];
    this.gas = [];                // gas half-hours (the gas heatmap), when the account has gas
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
    this.gasDays = this.info.gas ? byDay(this.gas) : null;
    const lg = lastOf(this.gas);
    this.gasCover = { from: this.info.gas?.from || null, last: Number.isFinite(lg) ? lg : null };
    // the unit Octopus reports gas in (m³ or kWh): the most common one loaded
    const units = new Map();
    for (const g of this.gas) units.set(g.unit, (units.get(g.unit) || 0) + 1);
    this.gasUnit = [...units].sort((a, b) => b[1] - a[1])[0]?.[0] || 'kWh';
  }

  /** The import tariff in force on a day (its agreement at local noon), or null. */
  tariffOn(dayKey) {
    return agreementAt(this.info.import?.agreements, midnight(dayKey) + 12 * 3600000)?.tariff || null;
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

  // A month is asked as windows of at most 10 local days, each within one 500-row page, import
  // and export together. Small asks are what EMT found reliable: its 60-day asks timed out where
  // 30-day ones landed (EMT CHANGELOG, 6 Nov 2026). The Octopus client keeps four in flight.
  async loadMonth(month) {
    const key = monthKey(this.info, month);
    const kept = this.cache ? await this.cache.get(key) : null;
    if (reusable(kept, month)) {
      // a month cached before gas was loaded: ask Octopus for its gas only, and keep it with the rest
      if (this.info.gas && !Array.isArray(kept.gas)) {
        kept.gas = await this._fetchGas(month);
        await this.cache?.put(key, kept);
      }
      this._add(month, kept.imp || [], kept.exp || [], kept.rates || [], kept.gas || []);
      return 'device';
    }
    const fresh = await this._fetchMonth(month);
    await this.cache?.put(key, { shape: CACHE_SHAPE, fetchedAt: Date.now(), ...fresh });
    this._add(month, fresh.imp, fresh.exp, fresh.rates, fresh.gas);
    return 'octopus';
  }

  /** A month's gas half-hours, in the same 10-day windows as electricity, or [] without gas. */
  async _fetchGas(month) {
    const g = this.info.gas;
    if (!g) return [];
    const windows = dayWindows(month.start, month.end, WINDOW_DAYS);
    return (await Promise.all(windows.map((w) => this.octo.gasMeasurements(this.info.number, g.mprn, w.start, w.end)))).flat();
  }

  _add(month, imp, exp, rates, gas = []) {
    this.imp.push(...imp);
    if (this.info.export) this.exp.push(...exp);
    if (this.info.gas) this.gas.push(...gas);
    for (const r of rates) {
      for (let s = r.from; s < Math.min(r.to ?? Infinity, midnight(month.end)); s += HALF_HOUR) this.published.set(s, r.exc);
    }
    this.loaded.push(month.start);
    this._rebuild();
  }

  async _fetchMonth(month) {
    const { number } = this.info;
    const imp = this.info.import;
    const windows = dayWindows(month.start, month.end, WINDOW_DAYS);
    const fetchAll = async (mpan, dir) => (await Promise.all(
      windows.map((w) => this.octo.measurements(number, mpan, w.start, w.end, dir)))).flat();
    const importing = imp ? (async () => {
      const got = await fetchAll(imp.mpan, 'CONSUMPTION');
      await recoverCosts(this.octo, number, imp.mpan, got, 'CONSUMPTION', dayKeyOf, Date.now(), imp.from);
      const ag = agreementAt(imp.agreements, midnight(month.start) + 15 * 86400000);
      const t = ag?.tariff;
      const rates = t?.productCode && /AGILE/i.test(t.productCode)
        ? await this.octo.publishedRates(t.productCode, t.tariffCode, month.start, month.end) : [];
      return { got, rates };
    })() : Promise.resolve(null);
    const exporting = this.info.export ? fetchAll(this.info.export.mpan, 'GENERATION') : Promise.resolve(null);
    const [i, e, gas] = await Promise.all([importing, exporting, this._fetchGas(month)]);
    // nothing is added until the whole month is in, so a month is never half shown. A rate's
    // open end (Infinity) is stored as null: IndexedDB keeps it, but plainly.
    return { imp: i?.got || [], exp: e || [], gas, rates: (i?.rates || []).map((r) => ({ ...r, to: Number.isFinite(r.to) ? r.to : null })) };
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
