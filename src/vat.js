// Domestic electricity VAT by UK local date (EMT's vat_calendar.py SEED). Each entry starts at
// local midnight. Octopus's half-hourly `costInclTax` carried 5% after 1 Oct 2026, so the
// VAT-inclusive figures here are always built from `costExclTax` and this calendar (design §5.3).
//
// That calendar is for domestic supplies. A business account pays the rate its own tariff carries
// (accountVat in data.js), usually 20%, the same on every day: vatFor() picks between them.

const CALENDAR = [
  ['1997-09-01', 0.05],
  ['2026-10-01', 0.0],
];

export function vatRate(dayKey) {
  let r = 0.05;
  for (const [from, rate] of CALENDAR) if (dayKey >= from) r = rate;
  return r;
}

/** UK VAT rates on electricity: zero, reduced (domestic, or a business under the de minimis limit), standard. */
export const STATUTORY = [0, 0.05, 0.2];

/** Snap a rate read from a tariff's inc / ex VAT figures to the statutory rate it is, or null. */
export function statutoryRate(r) {
  if (r == null || !Number.isFinite(r)) return null;
  const near = STATUTORY.reduce((a, b) => (Math.abs(b - r) < Math.abs(a - r) ? b : a));
  return Math.abs(near - r) <= 0.01 ? near : null;
}

/** The VAT rule for an account (`info.vat` from describeAccount), as dayKey → rate. A domestic
 *  account follows the calendar; a business account pays one rate throughout. */
export function vatFor(vat) {
  return vat?.business ? () => vat.rate : vatRate;
}
