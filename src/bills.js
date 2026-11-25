// The Bills view (design §1): a period picker (Bill / Month / Quarter / Year), the bill card with
// vs previous and vs last year, and a chart per day: kWh as bars, the charged rate as a stepped line.

import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Tooltip, Legend,
} from 'chart.js';
import { billPeriods, calendarPeriods, previousOf, lastYearOf, periodLabel } from './periods.js';
import { summarise, pounds, penny } from './bill.js';
import { vatFor } from './vat.js';
import { rateLine, solid, sideRateLine, exportRateLine, offWindowOf } from './rates.js';
import { daysBetween, slotsOfDay, todayKey, parseKey, addDays } from './time.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

// Okabe–Ito: distinguishable with red-green colour blindness. Off-peak is the lighter of each pair.
const PALETTE = {
  houseOff: '#56B4E9', housePeak: '#0072B2',   // sky blue, blue
  evOff: '#E69F00', evPeak: '#D55E00',         // orange, vermillion
  export: '#009E73', exportRate: '#7FD8BE',    // bluish green; its rate line a lighter tint of it
  other: '#F0E442', unsplit: '#999999',        // yellow, grey
  evRate: '#CC79A7',                           // reddish purple; the House / overall rate is the text colour
};

// Legend and tooltip keys (EMT's keyMark): a rate a short line, a bar a block.
const KEY_W = 22, KEY_H = 12;
const keyMarks = new Map();
function keyMark(ds) {
  const rate = !!ds._rate, color = rate ? ds.borderColor : ds.backgroundColor;
  const k = `${rate ? 'r' : 'b'}${color}${rate ? ds.borderWidth : ''}`;
  if (keyMarks.has(k)) return keyMarks.get(k);
  const c = document.createElement('canvas');
  c.width = KEY_W; c.height = KEY_H;
  const x = c.getContext('2d');
  if (rate) {
    x.strokeStyle = color; x.lineWidth = Math.min(4, ds.borderWidth || 2);
    x.beginPath(); x.moveTo(0, KEY_H / 2); x.lineTo(KEY_W, KEY_H / 2); x.stroke();
  } else {
    x.fillStyle = color; x.fillRect((KEY_W - 14) / 2, 1, 14, KEY_H - 2);
  }
  keyMarks.set(k, c);
  return c;
}

const MODES = [['bill', 'Bill'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtSlot = (s) => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;

/** The page's own header bar, which stays at the top above the bills' bar. */
const topBarHeight = () => document.querySelector('.top')?.offsetHeight || 0;

/** The bill card's VAT line: how VAT was added to Octopus's ex-VAT costs. */
export function vatNote(vat) {
  if (!vat?.business) return 'VAT added to Octopus’s ex-VAT costs by date (domestic rate).';
  const pct = `${+(vat.rate * 100).toFixed(1)}%`;
  return vat.source === 'tariff'
    ? `VAT at ${pct} added to Octopus’s ex-VAT costs: a business account, at the rate your tariff carries.`
    : `VAT at ${pct} added to Octopus’s ex-VAT costs: a business account, at the standard rate (your tariff does not show its VAT).`;
}

export const ISSUES_URL = 'https://github.com/RGx01/EMT-lite/issues/new/choose';

/** The bill card's last note: these figures are worked out, not Octopus's bill. */
function caveat() {
  const li = el('li', 'caveat', 'Worked out from Octopus’s half-hourly data: not your bill, and it may contain mistakes. Your Octopus statement is the one that counts. Something wrong? ');
  const a = el('a', null, 'Raise an issue');
  a.href = ISSUES_URL; a.target = '_blank'; a.rel = 'noopener noreferrer';
  li.append(a, '.');
  return li;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export class BillsView {
  constructor(root, data, { onBillingDay }) {
    this.root = root;
    this.data = data;
    this.vat = vatFor(data.info.vat);   // dayKey → VAT rate: the calendar, or a business account's rate
    this.onBillingDay = onBillingDay;
    this.mode = data.info.billing ? 'bill' : 'month';
    this.sel = null;
    this.prompt = null;          // the billing-day form, while open: { value, focus }
    this.showData = false;       // every day's data table open (the header's Show Data)
    this.charts = [];
    this.observer = null;
  }

  periods() {
    const first = this.data.firstDay(), last = todayKey();
    if (this.mode === 'bill') {
      const b = this.data.info.billing;
      if (!b) return [];
      return billPeriods(b.anchor, b.months, first, last);
    }
    return calendarPeriods(this.mode, first, last);
  }

  render() {
    this.destroyCharts();
    this.root.replaceChildren();
    const list = this.periods();

    // The header bar (EMT's period-nav): sticks to the top of the page while the days scroll.
    const head = el('div', 'bills-head');
    const row = el('div', 'bills-head-row');
    const modes = el('div', 'bills-modes');
    for (const [m, lab] of MODES) {
      const b = el('button', `mode${m === this.mode ? ' active' : ''}`, lab);
      b.type = 'button';
      b.addEventListener('click', () => { this.mode = m; this.sel = null; this.render(); });
      modes.append(b);
    }
    row.append(modes);
    head.append(row);
    this.root.append(head);
    if (!list.length) { this.root.append(el('p', 'muted', 'No data loaded yet.')); return; }

    let idx = list.findIndex((p) => p.start === this.sel);
    if (idx < 0) idx = list.length - 1;
    const p = list[idx];
    this.sel = p.start;

    const stepper = el('div', 'bills-stepper');
    const prev = el('button', null, '‹'), next = el('button', null, '›');
    prev.type = next.type = 'button';
    prev.disabled = idx === 0;
    next.disabled = idx === list.length - 1;
    prev.setAttribute('aria-label', 'Previous period');
    next.setAttribute('aria-label', 'Next period');
    prev.addEventListener('click', () => { this.sel = list[idx - 1].start; this.render(); });
    next.addEventListener('click', () => { this.sel = list[idx + 1].start; this.render(); });
    const select = el('select');
    select.setAttribute('aria-label', 'Period');
    list.forEach((q, i) => {
      const o = el('option', null, periodLabel(q, this.mode));
      o.value = q.start;
      if (i === idx) o.selected = true;
      select.append(o);
    });
    select.addEventListener('change', () => { this.sel = select.value; this.render(); });
    stepper.append(prev, select, next);
    row.append(stepper);

    // Show / Hide Data: every day's half-hour table at once (each day has its own button too)
    const dataBtn = el('button', `mode${this.showData ? ' active' : ''}`, this.showData ? 'Hide Data' : 'Show Data');
    dataBtn.type = 'button';
    dataBtn.title = 'Show or hide every day’s data table';
    dataBtn.addEventListener('click', () => {
      this.showData = !this.showData;
      dataBtn.textContent = this.showData ? 'Hide Data' : 'Show Data';
      dataBtn.classList.toggle('active', this.showData);
      for (const box of this.root.querySelectorAll('.day')) this.toggleTable(box, this.showData);
    });
    row.append(dataBtn);

    // The bill strip: once the bill has scrolled away, one line in the header with Show Bill
    const strip = el('div', 'bill-strip');
    strip.hidden = true;
    const stripLabel = el('span', 'bill-strip-label');
    const showBill = el('button', null, '↑ Show Bill');
    showBill.type = 'button';
    strip.append(stripLabel, showBill);
    head.append(strip);

    const where = el('div', 'bills-where');
    if (this.mode === 'bill') {
      const src = this.data.info.billing.source;
      const nth = ordinal(this.data.info.billing.day);
      const why = src === 'octopus' ? `billing day ${nth}, from Octopus` : src === 'trigger' ? `billing day ${nth}, from Octopus’s billing trigger`
        : src === 'demo' ? `demo billing day ${nth}` : src === 'user' ? `billing day ${nth}, your choice`
        : `billing day ${nth}: Octopus does not say, so the 1st`;
      const change = el('button', 'link', `${why} · change`);
      change.type = 'button';
      change.addEventListener('click', () => {
        this.prompt = { value: String(this.data.info.billing?.day ?? 1), focus: true };
        where.after(this.billingDayPrompt());
      });
      where.append(change);
    }
    this.root.append(where);
    // a redraw (each month that loads) keeps an open form and fold-out as they were
    if (this.mode === 'bill' && this.prompt) where.after(this.billingDayPrompt());

    const d = this.data;
    const sum = (q) => q && summarise(q, d.impDays, d.impCover, d.expDays, d.expCover, this.vat);
    const s = sum(p), sp = sum(previousOf(list, p)), sy = sum(lastYearOf(list, p));
    const card = this.card(p, s, sp, sy);
    this.root.append(card);
    this.root.append(this.days(p));

    stripLabel.textContent = `Bill — ${periodLabel(p, this.mode)} | ${pounds(s.bill.total)}${s.finished ? '' : ' so far'}`;
    showBill.addEventListener('click', () => card.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    this.stripObserver?.disconnect();
    this.stripObserver = new IntersectionObserver(([e]) => {
      strip.hidden = e.isIntersecting || e.boundingClientRect.top > 0;
    }, { rootMargin: `-${topBarHeight() + head.offsetHeight}px 0px 0px 0px` });
    this.stripObserver.observe(card);
  }

  /** Open or close one day's data table, building it the first time. */
  toggleTable(box, force) {
    const tbl = box.querySelector('.day-table'), btn = box.querySelector('.day-table-btn');
    const open = force !== undefined ? force : tbl.hidden;
    if (open && !tbl.dataset.built) { tbl.append(this.dayTable(box.dataset.day)); tbl.dataset.built = '1'; }
    tbl.hidden = !open;
    btn.classList.toggle('active', open);
  }

  /** A day's half-hours as a table: import (and Octopus's House / EV split), export, the rate. */
  dayTable(k) {
    const slots = [...slotsOfDay(k)].sort((a, b) => a - b);
    const day = this.data.impDays.get(k), eday = this.data.expDays?.get(k);
    const v = 1 + this.vat(k);
    const split = slots.some((s) => day?.get(s)?.split);
    const t = el('table', 'day-data');
    const head = ['Time', 'Import kWh', 'Rate p/kWh', 'Import £'];
    if (split) head.push('House kWh', 'House £', 'EV kWh', 'EV £');
    if (eday) head.push('Export kWh', 'Export p/kWh', 'Export £');
    const thead = el('thead'), hr = el('tr');
    for (const h of head) hr.append(el('th', null, h));
    thead.append(hr);
    t.append(thead);
    const tb = el('tbody');
    const tot = new Array(head.length).fill(0);
    const side = (iv, sd) => {
      if (!iv?.split) return [null, null];
      let k2 = 0, c = 0;
      for (const [key, e] of Object.entries(iv.split)) if (key.startsWith(`${sd}:`)) { k2 += e.kwh; c += e.cost; }
      return [k2, c * v];
    };
    const f = (x, dp) => (x == null ? '—' : x.toFixed(dp));
    for (const s of slots) {
      const iv = day?.get(s), ev = eday?.get(s);
      const cost = iv?.costExc != null ? iv.costExc * v : null;
      const cells = [fmtSlot(s), iv ? iv.kwh : null, cost != null && iv.kwh > 0.0005 ? cost / iv.kwh : null, cost != null ? cost / 100 : null];
      if (split) { const [hk, hc] = side(iv, 'home'), [ek, ec] = side(iv, 'ev'); cells.push(hk, hc != null ? hc / 100 : null, ek, ec != null ? ec / 100 : null); }
      if (eday) {
        const pay = ev?.costExc != null ? Math.abs(ev.costExc) : null;
        cells.push(ev ? ev.kwh : null, pay != null && ev.kwh > 0.0005 ? pay / ev.kwh : null, pay != null ? pay / 100 : null);
      }
      const tr = el('tr');
      cells.forEach((c, i) => {
        if (i === 0) { tr.append(el('td', null, c)); return; }
        const isRate = head[i].includes('p/kWh'), isMoney = head[i].endsWith('£');
        tr.append(el('td', 'num', f(c, isRate ? 2 : isMoney ? 4 : 3)));
        if (!isRate && c != null) tot[i] += c;
      });
      tb.append(tr);
    }
    t.append(tb);
    const tf = el('tfoot'), fr = el('tr');
    head.forEach((h, i) => {
      if (i === 0) { fr.append(el('td', null, 'Total')); return; }
      fr.append(el('td', 'num', h.includes('p/kWh') ? '' : f(tot[i], h.endsWith('£') ? 2 : 3)));
    });
    tf.append(fr);
    t.append(tf);
    const wrap = el('div', 'day-data-wrap');
    wrap.append(t);
    // the day header's £ is energy and standing charge together: say so under the table
    const sd = summarise({ start: k, end: addDays(k, 1) }, this.data.impDays, this.data.impCover, this.data.expDays, this.data.expCover, this.vat);
    const b = sd.bill;
    wrap.append(el('p', 'day-data-note', `Standing charge ${pounds(b.standingExc)} exc VAT · ${b.vatLabel} ${pounds(b.vat)}`
      + ` · day total incl. VAT ${pounds(b.incTotal)}${b.exportCredit ? ` · after export ${pounds(b.total)}` : ''}`
      + ' · the rows’ £ include VAT on import, none on export; the totals are rounded once, as on a bill.'));
    return wrap;
  }

  billingDayPrompt() {
    this.root.querySelector('.billing-day')?.remove();
    const box = el('form', 'billing-day');
    box.append(el('p', null, 'Which day of the month does your bill start? Bill periods run from that day to the day before it next month.'));
    const input = el('input');
    input.type = 'number'; input.min = '1'; input.max = '31'; input.required = true;
    input.value = this.prompt?.value ?? String(this.data.info.billing?.day ?? 1);
    input.setAttribute('aria-label', 'Billing day of the month');
    input.addEventListener('input', () => { if (this.prompt) this.prompt.value = input.value; });
    input.addEventListener('focus', () => { if (this.prompt) this.prompt.focus = true; });
    input.addEventListener('blur', () => { if (this.prompt) this.prompt.focus = false; });
    if (this.prompt?.focus) requestAnimationFrame(() => input.focus());
    const ok = el('button', 'primary', 'Use this day');
    ok.type = 'submit';
    const cancel = el('button', null, 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { this.prompt = null; box.remove(); });
    box.append(input, ok, cancel);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      this.prompt = null;
      this.onBillingDay(Number(input.value));
      this.mode = 'bill';
      this.sel = null;
      this.render();
    });
    return box;
  }

  card(p, s, sp, sy) {
    const card = el('section', 'bill-card');
    card.append(el('h2', null, periodLabel(p, this.mode)));
    const big = el('div', 'bill-total');
    big.append(el('span', 'amount', pounds(s.bill.total)), el('span', 'muted', s.exportKwh ? ' after export' : ' total'));
    card.append(big);
    const cmp = el('div', 'bill-cmp');
    const delta = (o, lab) => {
      if (!o || o.kwh === 0) return;
      const dv = s.bill.total - o.bill.total;
      cmp.append(el('span', dv > 0 ? 'up' : 'down', `${dv > 0 ? '▲' : '▼'} ${pounds(Math.abs(dv))} vs ${lab}`));
    };
    if (s.finished) {
      delta(sp, 'previous');
      delta(sy, 'last year');
    } else {
      cmp.append(el('span', 'muted', 'So far: compared with other periods once this one ends.'));
    }
    card.append(cmp);

    const t = el('table', 'bill-rows');
    const row = (a, b, c = '', cls = null) => {
      const tr = el('tr', cls);
      tr.append(el('th', null, a), el('td', null, b), el('td', 'num', c));
      t.append(tr);
    };
    // The bill's lines, ex VAT, as Octopus prints them (EMT's Bill Rounding, bill.js billMethod):
    // each half-hour summed unrounded, each line rounded once.
    const b = s.bill;
    const kwh = (v) => `${v.toFixed(1)} kWh`;
    const rate = (e) => (e.kwh > 0 ? ` @ ${(e.exc / e.kwh).toFixed(2)}p` : '');
    const exc = (e) => pounds(penny(e.exc));
    const sub = (text) => {
      const head = el('tr', 'sub-head');
      const th = el('th', null, text);
      th.colSpan = 3;
      head.append(th);
      t.append(head);
    };
    sub('Energy, exc VAT');
    if (s.offPeak.kwh) row('Off-peak', kwh(s.offPeak.kwh) + rate(s.offPeak), exc(s.offPeak));
    if (s.peak.kwh) row('Peak', kwh(s.peak.kwh) + rate(s.peak), exc(s.peak));
    if (s.unbanded.kwh) row('Energy', kwh(s.unbanded.kwh) + rate(s.unbanded), exc(s.unbanded));
    if (s.split) {
      sub('Octopus’s House / EV split, exc VAT');
      const NAMES = { ev: 'EV', home: 'House' }, BANDS = { off: 'off-peak', peak: 'peak', other: '' };
      for (const band of ['off', 'peak', 'other']) {
        for (const side of ['ev', 'home']) {
          const e = s.split[`${side}:${band}`];
          if (!e || (e.kwh < 0.0005 && Math.abs(e.exc) < 0.005)) continue;
          row(`${NAMES[side]} ${BANDS[band]}`.trim(), kwh(e.kwh) + rate(e), exc(e));
        }
      }
    }
    row('Energy total', kwh(s.kwh), pounds(b.energyExc), 'total');
    const soFar = s.finished ? '' : ' so far';
    if (b.standing.length) {
      for (const g of b.standing) row('Standing charge', `${g.days} day${g.days === 1 ? '' : 's'} @ ${g.rateExc.toFixed(2)}p${soFar}`, pounds(g.exc));
    } else {
      row('Standing charge', `${s.days} day${s.days === 1 ? '' : 's'}${soFar}`, pounds(0));
    }
    row(b.vatLabel, '', pounds(b.vat));
    row('Total incl. VAT', '', pounds(b.incTotal), 'total');
    if (s.exportKwh) row('Export', kwh(s.exportKwh), `−${pounds(b.exportCredit)}`);
    if (s.exportKwh) row('Bill after export', '', pounds(b.total), 'total');
    card.append(t);

    const notes = el('ul', 'bill-notes');
    if (s.missing) notes.append(el('li', 'warn', `${s.missing} half-hour${s.missing === 1 ? '' : 's'} with no reading from Octopus: this bill will look short. See the heatmap.`));
    if (s.uncostedSlots) notes.append(el('li', 'warn', `${s.uncostedKwh.toFixed(2)} kWh in ${s.uncostedSlots} half-hour${s.uncostedSlots === 1 ? '' : 's'} not costed by Octopus yet.`));
    if (s.unsplitSlots) notes.append(el('li', 'warn', `${s.unsplitSlots} costed half-hour${s.unsplitSlots === 1 ? '' : 's'} without Octopus’s House/EV split yet: the split rows add up to less than the energy.`));
    if (s.split) notes.append(el('li', 'muted', 'Octopus can revise its House/EV split for some days after it first appears.'));
    if (s.pending) notes.append(el('li', 'muted', `${s.pending} half-hour${s.pending === 1 ? '' : 's'} not in from Octopus yet.`));
    notes.append(el('li', 'muted', vatNote(this.data.info.vat)));
    notes.append(caveat());
    card.append(notes);
    return card;
  }

  days(p) {
    const wrap = el('section', 'bill-days');
    const ks = daysBetween(p.start, p.end).filter((k) => k <= todayKey()).reverse();
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !e.target.dataset.drawn) {
          e.target.dataset.drawn = '1';
          this.drawDay(e.target, e.target.dataset.day);
        }
      }
    }, { rootMargin: '600px 0px' });
    for (const k of ks) {
      const box = el('div', 'day');
      box.dataset.day = k;
      const { m, d } = parseKey(k);
      const s = summarise({ start: k, end: addDays(k, 1) },
        this.data.impDays, this.data.impCover, this.data.expDays, this.data.expCover, this.vat);
      const head = el('div', 'day-head');
      head.append(
        el('strong', null, `${DOW[new Date(`${k}T12:00:00Z`).getUTCDay()]} ${d} ${MON[m - 1]}`),
        el('span', 'muted', ` ${s.kwh.toFixed(2)} kWh · ${pounds(s.bill.incTotal)}${s.missing ? ` · ${s.missing} missing` : ''}`
          + `${s.uncostedSlots ? ` · ${s.uncostedSlots} not costed yet` : ''}`),
      );
      const holder = el('div', 'day-chart');
      holder.append(el('canvas'));
      const tbl = el('div', 'day-table');
      tbl.hidden = true;
      const bar = el('div', 'day-toolbar');
      const btn = el('button', 'day-table-btn', '☰ Data');
      btn.type = 'button';
      btn.title = 'Show or hide this day’s half-hours';
      btn.addEventListener('click', () => this.toggleTable(box));
      bar.append(btn);
      box.append(head, holder, tbl, bar);
      if (this.showData) this.toggleTable(box, true);
      wrap.append(box);
      this.observer.observe(box);
    }
    return wrap;
  }

  drawDay(box, k) {
    const slots = [...slotsOfDay(k)].sort((a, b) => a - b);
    const day = this.data.impDays.get(k);
    const eday = this.data.expDays?.get(k);
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const grid = dark ? '#2a2d3a' : '#e5e7eb', text = dark ? '#c9ccd6' : '#444';
    const iv = (s) => day?.get(s);
    const bar = (label, color, value) => ({ type: 'bar', label, yAxisID: 'kwh', order: 2, stack: 'kwh',
      backgroundColor: color, data: slots.map(value) });
    const line = (label, color, rates) => ({ type: 'line', label, yAxisID: 'rate', order: 1, _rate: true,
      data: slots.map((s) => rates.get(s)), stepped: 'middle', borderColor: color, borderWidth: 2,
      pointRadius: 0, spanGaps: true, borderDash: [] });
    const datasets = [];
    const split = slots.some((s) => iv(s)?.split);
    if (split) {
      // Octopus's IOG-SMB House/EV split, each bucket a bar; a half-hour not split yet is one bar
      const part = (key) => (s) => { const e = iv(s)?.split?.[key]; return e && e.kwh > 0 ? e.kwh : null; };
      datasets.push(
        bar('House off-peak', PALETTE.houseOff, part('home:off')),
        bar('House peak', PALETTE.housePeak, part('home:peak')),
        bar('EV off-peak', PALETTE.evOff, part('ev:off')),
        bar('EV peak', PALETTE.evPeak, part('ev:peak')),
      );
      if (slots.some((s) => (iv(s)?.split?.['ev:other']?.kwh || 0) + (iv(s)?.split?.['home:other']?.kwh || 0) > 0)) {
        datasets.push(bar('Other bucket', PALETTE.other,
          (s) => ((iv(s)?.split?.['ev:other']?.kwh || 0) + (iv(s)?.split?.['home:other']?.kwh || 0)) || null));
      }
      if (slots.some((s) => iv(s) && !iv(s).split)) {
        datasets.push(bar('Not split yet', PALETTE.unsplit, (s) => (iv(s) && !iv(s).split ? iv(s).kwh : null)));
      }
      datasets.push(line('House rate p/kWh', text, sideRateLine(k, day, slots, 'home', this.vat)));
      if (slots.some((s) => (iv(s)?.split?.['ev:off']?.kwh || 0) + (iv(s)?.split?.['ev:peak']?.kwh || 0) > 0)) {
        // wider and beneath the House line: where the two rates are the same, it shows as an edge
        datasets.push({ ...line('EV rate p/kWh', PALETTE.evRate, sideRateLine(k, day, slots, 'ev', this.vat)), order: 1.5, borderWidth: 6 });
      }
    } else {
      datasets.push(
        bar('Import off-peak', PALETTE.houseOff, (s) => (iv(s)?.offPeak === true ? iv(s).kwh : null)),
        bar('Import peak', PALETTE.housePeak, (s) => (iv(s) && iv(s).offPeak !== true ? iv(s).kwh : null)),
        line('Rate p/kWh', text, solid(rateLine(k, day, slots, this.data.publishedFor(k), this.vat, offWindowOf(this.data.tariffOn(k))), slots)),
      );
    }
    if (eday) {
      datasets.push({ ...bar('Export', PALETTE.export, (s) => (eday.get(s) ? -eday.get(s).kwh : null)), stack: 'kwh' });
      const er = exportRateLine(eday, slots);
      if (slots.some((s) => er.get(s) != null)) datasets.push(line('Export rate p/kWh', dark ? PALETTE.exportRate : '#00684C', er));
    }
    for (const d of datasets) if (d.type === 'bar' && d.data.every((v) => v == null)) d.hidden = true;
    // The rate axis shares the kWh axis's zero (EMT's _alignY2): with export below zero, the rate
    // axis reaches below zero by the same proportion, and its negative ticks are not labelled.
    let kMin = 0, kMax = 0;
    slots.forEach((_, i) => {
      let pos = 0, neg = 0;
      for (const d of datasets) if (d.type === 'bar' && !d.hidden) { const v = d.data[i] || 0; if (v > 0) pos += v; else neg += v; }
      kMax = Math.max(kMax, pos); kMin = Math.min(kMin, neg);
    });
    const up = (v, step) => Math.max(step, Math.ceil((v - 1e-9) / step) * step);
    const rMax = up(Math.max(1, ...datasets.filter((d) => d.type === 'line').flatMap((d) => d.data.filter((v) => v != null))) * 1.05, 5);
    kMax = up(kMax * 1.05, 0.5);
    kMin = kMin < 0 ? -up(-kMin * 1.05, 0.5) : 0;
    const rMin = rMax * (kMin / kMax);

    const chart = new Chart(box.querySelector('canvas'), {
      data: { labels: slots.map(fmtSlot), datasets: datasets.filter((d) => !(d.type === 'bar' && d.hidden)) },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: grid } },
          kwh: { position: 'left', stacked: true, min: kMin, max: kMax,
            title: { display: true, text: 'kWh', color: text }, ticks: { color: text, stepSize: 0.5 }, grid: { color: grid } },
          rate: { position: 'right', min: rMin, max: rMax, title: { display: true, text: 'p/kWh', color: text },
            ticks: { color: text, stepSize: 5, callback: (v) => (v < 0 || Math.abs(v % 5) > 1e-6 ? '' : v) }, grid: { display: false } },
        },
        plugins: {
          // A rate's key is a line and a bar's a block, the same in the legend and the hover
          // (EMT's keyMark): Chart.js would draw a line's key as a box.
          legend: { labels: { color: text, usePointStyle: true, pointStyleWidth: KEY_W,
            generateLabels: (ch) => Chart.defaults.plugins.legend.labels.generateLabels(ch).map((it) => (
              { ...it, pointStyle: keyMark(ch.data.datasets[it.datasetIndex]) })) } },
          tooltip: { usePointStyle: true, boxWidth: KEY_W, boxHeight: KEY_H, callbacks: {
            labelPointStyle: (c) => ({ pointStyle: keyMark(c.dataset), rotation: 0 }),
            label: (c) => (c.parsed.y == null ? null
            : `${c.dataset.label}: ${Math.abs(c.parsed.y).toFixed(c.dataset.yAxisID === 'rate' ? 2 : 3)}`) } },
        },
      },
    });
    this.charts.push(chart);
  }

  destroyCharts() {
    for (const c of this.charts) c.destroy();
    this.charts = [];
    this.observer?.disconnect();
    this.stripObserver?.disconnect();
  }
}


function ordinal(n) {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suf}`;
}
