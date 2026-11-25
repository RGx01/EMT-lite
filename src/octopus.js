// The only code that talks to Octopus (design §4, §5). Every request goes to api.octopus.energy,
// which the page's CSP enforces as well.
//
// The API key is used once, for obtainKrakenToken, and is not kept: the page holds the token
// (about an hour) and the refresh token. No mutation other than obtainKrakenToken is ever sent.

import { parseNode } from './measurements.js';
import { isoLocal, midnight, addDays, TZ } from './time.js';

const GQL = 'https://api.octopus.energy/v1/graphql/';
const REST = 'https://api.octopus.energy/v1';
const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const PACE_MS = 400;               // between requests: one account's limit is shared (design §5.4)
const REFRESH_SKEW_S = 120;

const TOKEN_MUTATION =
  'mutation getToken($input: ObtainJSONWebTokenInput!) { obtainKrakenToken(input: $input) { token refreshToken refreshExpiresIn } }';

export class OctopusError extends Error {
  constructor(message, { code = null, status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function jwtExp(token) {
  try {
    const b = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b)).exp || null;
  } catch {
    return null;
  }
}

export class Octopus {
  constructor() {
    this.token = null;
    this.tokenExp = null;
    this.refreshToken = null;
    this.refreshExp = null;          // Unix seconds (Octopus's refreshExpiresIn)
    this._last = 0;
  }

  // ── sign-in ────────────────────────────────────────────────────────────────

  async signInWithKey(apiKey) {
    await this._obtain({ APIKey: String(apiKey).trim() });
  }

  async signInWithRefreshToken(refreshToken) {
    await this._obtain({ refreshToken });
  }

  async _obtain(input) {
    const data = await this._post(TOKEN_MUTATION, { input }, false);
    const t = data.obtainKrakenToken;
    if (!t?.token) throw new OctopusError('Octopus did not return a token.');
    this.token = t.token;
    this.tokenExp = jwtExp(t.token);
    this.refreshToken = t.refreshToken || null;
    this.refreshExp = t.refreshExpiresIn || null;
    this.onTokens?.(this);
  }

  async _ensureToken() {
    if (!this.token) throw new OctopusError('Not signed in.');
    if (this.tokenExp && Date.now() / 1000 > this.tokenExp - REFRESH_SKEW_S) {
      if (!this.refreshToken) throw new OctopusError('Your Octopus session has expired. Paste your API key again.');
      await this._obtain({ refreshToken: this.refreshToken });
    }
  }

  signOut() {
    this.token = this.tokenExp = this.refreshToken = this.refreshExp = null;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  async gql(query, variables = {}) {
    if (/^\s*mutation\b/.test(query)) throw new OctopusError('EMT-Lite sends no mutations.');
    await this._ensureToken();
    return this._post(query, variables, true);
  }

  async _pace() {
    const wait = this._last + PACE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    this._last = Date.now();
  }

  async _post(query, variables, auth) {
    if (/^\s*mutation\b/.test(query) && query !== TOKEN_MUTATION) {
      throw new OctopusError('EMT-Lite sends no mutations.');
    }
    for (let attempt = 0; ; attempt++) {
      await this._pace();
      let res;
      try {
        res = await fetch(GQL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: this.token } : {}) },
          body: JSON.stringify({ query, variables }),
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        });
      } catch (e) {
        if (attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt]); continue; }
        throw new OctopusError('Could not reach Octopus. Check your connection.');
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[attempt]); continue; }
        throw new OctopusError(`Octopus answered ${res.status}. Try again later.`, { status: res.status });
      }
      const body = await res.json().catch(() => ({}));
      const errors = body.errors || [];
      if (errors.length) {
        const code = errors[0]?.extensions?.errorCode || null;
        if (code === 'KT-CT-1199' && attempt < RETRY_DELAYS.length) {
          await sleep(RETRY_DELAYS[attempt] * 4);
          continue;
        }
        throw new OctopusError(errors[0]?.message || 'Octopus returned an error.', { code });
      }
      return body.data || {};
    }
  }

  // ── what the page asks ─────────────────────────────────────────────────────

  async accountNumbers() {
    const d = await this.gql('query { viewer { accounts { number } } }');
    return (d.viewer?.accounts || []).map((a) => a.number);
  }

  async accountInfo(number) {
    const tariff = (t) => `... on ${t} { productCode tariffCode isExport displayName }`;
    const d = await this.gql(
      `query acc($n: String!) { account(accountNumber: $n) {
        billingOptions { periodStartDay periodLength periodLengthMultiplier isFixed
          currentBillingPeriodStartDate currentBillingPeriodEndDate nextBillingDate }
        properties { id electricityMeterPoints { mpan direction
          agreements(includeInactive: true) { validFrom validTo tariff {
            ${['StandardTariff', 'DayNightTariff', 'ThreeRateTariff', 'FourRateEvTariff', 'HalfHourlyTariff', 'PrepayTariff'].map(tariff).join(' ')}
          } } } } } }`,
      { n: number },
    );
    return d.account || null;
  }

  /** The account's recent bills, newest first: [{ fromDate, toDate, issuedDate, billType }]. */
  async recentBills(number) {
    const d = await this.gql(
      'query b($n: String!) { account(accountNumber: $n) { bills(first: 12) { edges { node { billType fromDate toDate issuedDate } } } } }',
      { n: number },
    );
    return (d.account?.bills?.edges || []).map((e) => e.node).filter((b) => b?.fromDate)
      .sort((x, y) => String(y.fromDate).localeCompare(String(x.fromDate)));
  }

  /** Half-hours for [fromKey, toKey) local days, with costs. `direction`: CONSUMPTION | GENERATION. */
  async measurements(number, mpan, fromKey, toKey, direction = 'CONSUMPTION') {
    return this.measurementsBetween(number, mpan, midnight(fromKey), midnight(toKey), direction);
  }

  /** Half-hours for [startMs, endMs). Ask exact local days or months: a padded window comes back
   *  without costs (design §5.3). */
  async measurementsBetween(number, mpan, startMs, endMs, direction = 'CONSUMPTION') {
    const dir = direction === 'GENERATION' ? 'GENERATION' : 'CONSUMPTION';
    const q = `query meas($n: String!, $mpan: String!, $start: DateTime!, $end: DateTime!, $first: Int!, $after: String) {
      account(accountNumber: $n) { properties {
        measurements(first: $first, after: $after, startAt: $start, endAt: $end, timezone: "${TZ}",
          utilityFilters: [{ electricityFilters: { readingFrequencyType: THIRTY_MIN_INTERVAL,
            marketSupplyPointId: $mpan, readingDirection: ${dir} } }]) {
          edges { node { value unit ... on IntervalMeasurementType { startAt endAt
            metaData { statistics { type label value costInclTax { estimatedAmount } costExclTax { estimatedAmount } } } } } }
          pageInfo { hasNextPage endCursor } } } } }`;
    const out = [];
    let after = null;
    for (let page = 0; page < 200; page++) {
      const d = await this.gql(q, {
        n: number, mpan, start: isoLocal(startMs), end: isoLocal(endMs), first: 500, after,
      });
      const conn = (d.account?.properties || []).map((p) => p.measurements).find((m) => m && (m.edges || m.pageInfo));
      if (!conn) break;
      for (const e of conn.edges || []) {
        const iv = parseNode(e.node);
        if (iv) out.push(iv);
      }
      if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }

  /** Agile's published unit rates, ex VAT, p/kWh. Public: no key or token is sent. */
  async publishedRates(productCode, tariffCode, fromKey, toKey) {
    const out = [];
    let url = `${REST}/products/${encodeURIComponent(productCode)}/electricity-tariffs/${encodeURIComponent(tariffCode)}`
      + `/standard-unit-rates/?page_size=1500&period_from=${encodeURIComponent(new Date(midnight(fromKey)).toISOString())}`
      + `&period_to=${encodeURIComponent(new Date(midnight(toKey)).toISOString())}`;
    for (let page = 0; url && page < 20; page++) {
      await this._pace();
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new OctopusError(`Octopus answered ${res.status} for published rates.`, { status: res.status });
      const body = await res.json();
      out.push(...(body.results || []));
      url = body.next && body.next.startsWith(REST) ? body.next : null;
    }
    return out.map((r) => ({ from: Date.parse(r.valid_from), to: r.valid_to ? Date.parse(r.valid_to) : Infinity, exc: r.value_exc_vat }));
  }
}

/** Fill costs Octopus left out of a month's answer: ask those local days, then noon to noon
 *  (EMT's recover_measurement_costs). Mutates and returns `intervals`. */
export async function recoverCosts(octo, number, mpan, intervals, direction, dayKeyOf, now = Date.now()) {
  // The last three days are usually not priced yet: asking again would only spend the account's
  // rate limit. Recovery is for the older holes a month's answer leaves.
  const recent = dayKeyOf(now - 3 * 86400000);
  const lacking = () => intervals.filter((iv) => iv.costExc == null && iv.kwh > 0 && dayKeyOf(iv.start) < recent);
  const merge = (got) => {
    const by = new Map(got.filter((g) => g.costExc != null).map((g) => [g.start, g]));
    for (const iv of intervals) {
      const g = by.get(iv.start);
      if (iv.costExc == null && g) { iv.costExc = g.costExc; iv.offPeak = g.offPeak; if (iv.standingExc == null) iv.standingExc = g.standingExc; }
    }
  };
  for (const k of new Set(lacking().map((iv) => dayKeyOf(iv.start)))) {
    merge(await octo.measurements(number, mpan, k, addDays(k, 1), direction));
  }
  // noon to noon: the half of the day before midday from the previous noon, the rest to the next
  const NOON = 12 * 3600 * 1000;
  for (const k of new Set(lacking().map((iv) => dayKeyOf(iv.start)))) {
    const m0 = midnight(k);
    merge(await octo.measurementsBetween(number, mpan, m0 - NOON, m0 + NOON, direction));
    if (lacking().some((iv) => dayKeyOf(iv.start) === k)) {
      merge(await octo.measurementsBetween(number, mpan, m0 + NOON, midnight(addDays(k, 1)) + NOON, direction));
    }
  }
  return intervals;
}
