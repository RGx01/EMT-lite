// Domestic electricity VAT by UK local date (EMT's vat_calendar.py SEED). Each entry starts at
// local midnight. Octopus's half-hourly `costInclTax` carried 5% after 1 Oct 2026, so the
// VAT-inclusive figures here are always built from `costExclTax` and this calendar (design §5.3).
//
// Domestic only: a business supply pays 20%, which this calendar does not know.

const CALENDAR = [
  ['1997-09-01', 0.05],
  ['2026-10-01', 0.0],
];

export function vatRate(dayKey) {
  let r = 0.05;
  for (const [from, rate] of CALENDAR) if (dayKey >= from) r = rate;
  return r;
}
