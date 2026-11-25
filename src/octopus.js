// The only code that talks to Octopus (design §4, §5). Every request goes to api.octopus.energy,
// which the page's CSP enforces as well.
//
// The API key is used once, for obtainKrakenToken, and is not kept: the page holds the token
// (about an hour) and the refresh token. No mutation other than obtainKrakenToken is ever sent.

import { parseNode } from './measurements.js';
import { isoLocal, midnight, addDays, addMonths, parseKey, noon, TZ } from './time.js';

const GQL = 'https://api.octopus.energy/v1/graphql/';
const REST = 'https://api.octopus.energy/v1';
const RETRY_DELAYS = [1000, 2000, 4000, 8000];
const PACE_MS = 400;               // between request starts: one account's limit is shared (design §5.4)
const MAX_IN_FLIGHT = 4;           // small asks, a few at a time: EMT found big asks time out
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
      // requests run several at a time: the first to notice refreshes, the rest wait for it
      this._refreshing = this._refreshing || this._obtain({ refreshToken: this.refreshToken })
        .finally(() => { this._refreshing = null; });
      await this._refreshing;
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
    this._last = Math.max(Date.now(), this._last + PACE_MS);     // reserve the next start
    if (wait > 0) await sleep(wait);
  }

  /** Run `fn` when fewer than MAX_IN_FLIGHT requests are out. */
  async _slot(fn) {
    this._inFlight = this._inFlight || 0;
    this._queue = this._queue || [];
    if (this._inFlight >= MAX_IN_FLIGHT) await new Promise((r) => this._queue.push(r));
    this._inFlight++;
    try {
      return await fn();
    } finally {
      this._inFlight--;
      this._queue.shift()?.();
    }
  }

  _post(query, variables, auth) {
    return this._slot(() => this._postNow(query, variables, auth));
  }

  async _postNow(query, variables, auth) {
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

  /** Kraken's billing trigger: the day of the month billing runs, if the account has one. */
  async billingTrigger(number) {
    const d = await this.gql(
      `query t($n: String!) { account(accountNumber: $n) { billingTriggerConfiguration { isActive nextIssueDate
        operationFrequencies { operationType targetType frequency multiplier triggerAtStartDay triggerAtStartMonth } } } }`,
      { n: number },
    );
    return d.account?.billingTriggerConfiguration || null;
  }

  /** Active payment schedules (the Direct Debit day): shown, never taken as the billing day. */
  async paymentSchedules(number) {
    const d = await this.gql(
      `query p($n: String!) { account(accountNumber: $n) { paymentSchedules(first: 5, active: true) { edges { node {
        paymentDay paymentFrequency paymentFrequencyMultiplier validFrom validTo } } } } }`,
      { n: number },
    );
    return (d.account?.paymentSchedules?.edges || []).map((e) => e.node).filter(Boolean);
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
            metaData { statistics { type label value costExclTax { estimatedAmount } } } } } }
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
      const body = await this._slot(async () => {
        const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!res.ok) throw new OctopusError(`Octopus answered ${res.status} for published rates.`, { status: res.status });
        return res.json();
      });
      out.push(...(body.results || []));
      url = body.next && body.next.startsWith(REST) ? body.next : null;
    }
    return out.map((r) => ({ from: Date.parse(r.valid_from), to: r.valid_to ? Date.parse(r.valid_to) : Infinity, exc: r.value_exc_vat }));
  }
}

/**
 * Fill costs Octopus left out (EMT's recover_measurement_costs, design §5.3), in EMT's order:
 * each half-hour's exact local DAY; what that leaves, its local MONTH; what that leaves, NOON TO
 * NOON (the previous noon to this noon for a half-hour before midday, else this noon to the next).
 * On some days Octopus costs nothing in any window that STARTS at that day's midnight, whatever
 * its end, and everything in one that starts later: noon to noon recovered 57 of 72 such
 * half-hours in EMT (18 Nov 2026). So a window with no costs at all is still worth recovering.
 *
 * Not asked: the last three days (usually not priced yet) and days before the supply started
 * (another supplier's kWh: Octopus prices none of it). Mutates and returns `intervals`.
 */
export async function recoverCosts(octo, number, mpan, intervals, direction, dayKeyOf, now = Date.now(), supplyFrom = null) {
  const recent = dayKeyOf(now - 3 * 86400000);
  const lacking = () => intervals.filter((iv) => iv.costExc == null && iv.kwh > 0 && dayKeyOf(iv.start) < recent
    && (!supplyFrom || dayKeyOf(iv.start) >= supplyFrom));
  const merge = (got) => {
    const by = new Map(got.filter((g) => g.costExc != null).map((g) => [g.start, g]));
    for (const iv of intervals) {
      const g = by.get(iv.start);
      if (iv.costExc == null && g) {
        iv.costExc = g.costExc;
        iv.offPeak = g.offPeak;
        iv.split = g.split;
        if (iv.standingExc == null) iv.standingExc = g.standingExc;
      }
    }
  };
  let asked = 0;
  const ask = async (windows) => {
    for (const [a, b] of [...windows.values()].sort((x, y) => y[0] - x[0])) {      // newest first
      if (!lacking().length) return;
      asked++;
      merge(await octo.measurementsBetween(number, mpan, a, b, direction));
    }
  };
  const windowsOf = (f) => { const m = new Map(); for (const iv of lacking()) { const w = f(iv); m.set(w.join(), w); } return m; };
  const total = lacking().length;
  if (!total) return intervals;
  const asked0 = asked;
  await ask(windowsOf((iv) => { const k = dayKeyOf(iv.start); return [midnight(k), midnight(addDays(k, 1))]; }));
  const afterDay = lacking().length;
  await ask(windowsOf((iv) => {
    const k = dayKeyOf(iv.start), first = `${k.slice(0, 8)}01`;
    const { y, m } = parseKey(first);
    return [midnight(first), midnight(addMonths(y, m, 1, 1))];
  }));
  await ask(windowsOf((iv) => {
    const k = dayKeyOf(iv.start), n = noon(k);
    return iv.start < n ? [noon(addDays(k, -1)), n] : [n, noon(addDays(k, 1))];
  }));
  // EMT's log line: counts only, nothing about the account
  const left = lacking().length;
  console.info(`recover costs ${direction}: ${total - left}/${total} half-hours recovered `
    + `(day ${total - afterDay}, then month and noon ${afterDay - left}), ${asked - asked0} requests, ${left} still without a cost`);
  return intervals;
}
