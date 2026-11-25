// Every GraphQL document EMT-Lite sends to Octopus's Kraken API, in one place, so that the weekly
// schema check (scripts/check-kraken.mjs) validates exactly what the page sends: a field Octopus
// deprecates or removes shows up there before the page breaks.

import { TZ } from './time.js';

/** The only mutation: the API key (or a refresh token) for a token. */
export const TOKEN_MUTATION =
  'mutation getToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token refreshToken refreshExpiresIn } }';

export const ACCOUNT_NUMBERS = 'query { viewer { accounts { number } } }';

const TARIFF_TYPES = ['StandardTariff', 'DayNightTariff', 'ThreeRateTariff', 'FourRateEvTariff', 'HalfHourlyTariff', 'PrepayTariff'];
const tariff = (t) => `... on ${t} { productCode tariffCode isExport displayName standingCharge preVatStandingCharge }`;

export const ACCOUNT_INFO =
      `query acc($n: String!) { account(accountNumber: $n) { accountType
        billingOptions { periodStartDay periodLength periodLengthMultiplier isFixed
          currentBillingPeriodStartDate currentBillingPeriodEndDate nextBillingDate }
        properties { id electricityMeterPoints { mpan direction
          agreements(includeInactive: true) { validFrom validTo tariff {
            ${TARIFF_TYPES.map(tariff).join(' ')}
          } } }
        gasMeterPoints { mprn agreements(includeInactive: true) { validFrom validTo } } } } }`;

export const BILLING_TRIGGER =
      `query t($n: String!) { account(accountNumber: $n) { billingTriggerConfiguration { isActive nextIssueDate
        operationFrequencies { operationType targetType frequency multiplier triggerAtStartDay triggerAtStartMonth } } } }`;

/** Half-hourly measurements with costs; `dir` CONSUMPTION (import) or GENERATION (export). */
export function measurementsQuery(dir) {
  return `query meas($n: String!, $mpan: String!, $start: DateTime!, $end: DateTime!, $first: Int!, $after: String) {
      account(accountNumber: $n) { properties {
        measurements(first: $first, after: $after, startAt: $start, endAt: $end, timezone: "${TZ}",
          utilityFilters: [{ electricityFilters: { readingFrequencyType: THIRTY_MIN_INTERVAL,
            marketSupplyPointId: $mpan, readingDirection: ${dir} } }]) {
          edges { node { value unit ... on IntervalMeasurementType { startAt endAt
            metaData { statistics { type label value costExclTax { estimatedAmount } } } } } }
          pageInfo { hasNextPage endCursor } } } } }`;
}

/** Half-hourly gas readings (the gas heatmap; no costs: gas is not billed here). `unit` says
 *  whether a reading is m³ or kWh. */
export const GAS_MEASUREMENTS = `query gas($n: String!, $mprn: String!, $start: DateTime!, $end: DateTime!, $first: Int!, $after: String) {
      account(accountNumber: $n) { properties {
        measurements(first: $first, after: $after, startAt: $start, endAt: $end, timezone: "${TZ}",
          utilityFilters: [{ gasFilters: { readingFrequencyType: THIRTY_MIN_INTERVAL, marketSupplyPointId: $mprn } }]) {
          edges { node { value unit ... on IntervalMeasurementType { startAt endAt } } }
          pageInfo { hasNextPage endCursor } } } } }`;

/** Every document, by name, for the schema check. */
export const ALL_DOCUMENTS = {
  obtainKrakenToken: TOKEN_MUTATION,
  accountNumbers: ACCOUNT_NUMBERS,
  accountInfo: ACCOUNT_INFO,
  billingTrigger: BILLING_TRIGGER,
  measurementsImport: measurementsQuery('CONSUMPTION'),
  measurementsExport: measurementsQuery('GENERATION'),
  measurementsGas: GAS_MEASUREMENTS,
};
