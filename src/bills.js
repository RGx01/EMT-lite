// The Bills view (design §1): a period picker (Bill / Month / Quarter / Year), the bill card with
// vs previous and vs last year, and a chart per day: kWh as bars, the charged rate as a stepped line.

import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Tooltip, Legend,
} from 'chart.js';
import { billPeriods, calendarPeriods, previousOf, lastYearOf, periodLabel } from './periods.js';
import { summarise, pounds } from './bill.js';
import { rateLine } from './rates.js';
import { daysBetween, slotsOfDay, todayKey, parseKey, addDays } from './time.js';

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip, Legend);

const MODES = [['bill', 'Bill'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtSlot = (s) => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;

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
    this.onBillingDay = onBillingDay;
    this.mode = data.info.billing ? 'bill' : 'month';
    this.sel = null;
    this.charts = [];
    this.observer = null;
  }

  periods() {
    const first = this.data.firstDay(), last = todayKey();
    if (this.mode === 'bill') {
      const b = this.data.info.billing;
      return b ? billPeriods(b.anchor, b.months, first, last) : [];
    }
    return calendarPeriods(this.mode, first, last);
  }

  render() {
    this.destroyCharts();
    this.root.replaceChildren();
    const list = this.periods();
    const bar = el('div', 'bills-bar');
    for (const [m, lab] of MODES) {
      const b = el('button', `mode${m === this.mode ? ' active' : ''}`, lab);
      b.type = 'button';
      b.addEventListener('click', () => { this.mode = m; this.sel = null; this.render(); });
      bar.append(b);
    }
    this.root.append(bar);

    if (this.mode === 'bill' && !this.data.info.billing) {
      this.root.append(this.billingDayPrompt());
      return;
    }
    if (!list.length) { this.root.append(el('p', 'muted', 'No data loaded yet.')); return; }

    let idx = list.findIndex((p) => p.start === this.sel);
    if (idx < 0) idx = list.length - 1;
    const p = list[idx];
    this.sel = p.start;

    const nav = el('div', 'bills-nav');
    const prev = el('button', null, '‹'), next = el('button', null, '›');
    prev.type = next.type = 'button';
    prev.disabled = idx === 0;
    next.disabled = idx === list.length - 1;
    prev.setAttribute('aria-label', 'Previous period');
    next.setAttribute('aria-label', 'Next period');
    prev.addEventListener('click', () => { this.sel = list[idx - 1].start; this.render(); });
    next.addEventListener('click', () => { this.sel = list[idx + 1].start; this.render(); });
    const select = el('select');
    list.forEach((q, i) => {
      const o = el('option', null, periodLabel(q, this.mode));
      o.value = q.start;
      if (i === idx) o.selected = true;
      select.append(o);
    });
    select.addEventListener('change', () => { this.sel = select.value; this.render(); });
    nav.append(prev, select, next);
    if (this.mode === 'bill') {
      const src = this.data.info.billing.source;
      const why = src === 'octopus' ? 'billing day from Octopus' : src === 'bills' ? 'billing day from your bills'
        : src === 'demo' ? 'demo billing day' : 'billing day you entered';
      const change = el('button', 'link', `${why} · change`);
      change.type = 'button';
      change.addEventListener('click', () => { this.root.append(this.billingDayPrompt()); });
      nav.append(change);
    }
    this.root.append(nav);

    const d = this.data;
    const sum = (q) => q && summarise(q, d.impDays, d.impCover, d.expDays, d.expCover);
    const s = sum(p), sp = sum(previousOf(list, p)), sy = sum(lastYearOf(list, p));
    this.root.append(this.card(p, s, sp, sy));
    this.root.append(this.days(p));
  }

  billingDayPrompt() {
    const box = el('form', 'billing-day');
    box.append(el('p', null, 'Octopus did not say which day your bill starts. Enter it to see bill periods.'));
    const input = el('input');
    input.type = 'number'; input.min = '1'; input.max = '31'; input.required = true;
    input.setAttribute('aria-label', 'Billing day of the month');
    const ok = el('button', null, 'Use this day');
    ok.type = 'submit';
    box.append(input, ok);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      this.onBillingDay(Number(input.value));
      this.mode = 'bill';
      this.render();
    });
    return box;
  }

  card(p, s, sp, sy) {
    const card = el('section', 'bill-card');
    card.append(el('h2', null, periodLabel(p, this.mode)));
    const big = el('div', 'bill-total');
    big.append(el('span', 'amount', pounds(s.net)), el('span', 'muted', s.exportKwh ? ' after export' : ' total'));
    card.append(big);
    const cmp = el('div', 'bill-cmp');
    const delta = (o, lab) => {
      if (!o || o.kwh === 0) return;
      const dv = s.net - o.net;
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
    const row = (a, b, c = '') => {
      const tr = el('tr');
      tr.append(el('th', null, a), el('td', null, b), el('td', 'num', c));
      t.append(tr);
    };
    const kwh = (v) => `${v.toFixed(1)} kWh`;
    const rate = (b) => (b.kwh > 0 ? ` @ ${(b.cost / b.kwh).toFixed(2)}p` : '');
    if (s.offPeak.kwh) row('Off-peak', kwh(s.offPeak.kwh) + rate(s.offPeak), pounds(s.offPeak.cost));
    if (s.peak.kwh) row('Peak', kwh(s.peak.kwh) + rate(s.peak), pounds(s.peak.cost));
    if (s.unbanded.kwh) row('Energy', kwh(s.unbanded.kwh) + rate(s.unbanded), pounds(s.unbanded.cost));
    row('Standing charge', `${s.days} day${s.days === 1 ? '' : 's'}${s.finished ? '' : ' so far'}`, pounds(s.standing));
    row('Import total', kwh(s.kwh), pounds(s.total));
    if (s.exportKwh) row('Export', kwh(s.exportKwh), `−${pounds(s.exportCredit)}`);
    card.append(t);

    const notes = el('ul', 'bill-notes');
    if (s.missing) notes.append(el('li', 'warn', `${s.missing} half-hour${s.missing === 1 ? '' : 's'} with no reading from Octopus: this bill will look short. See the heatmap.`));
    if (s.uncostedSlots) notes.append(el('li', 'warn', `${s.uncostedKwh.toFixed(2)} kWh in ${s.uncostedSlots} half-hour${s.uncostedSlots === 1 ? '' : 's'} not costed by Octopus yet.`));
    if (s.pending) notes.append(el('li', 'muted', `${s.pending} half-hour${s.pending === 1 ? '' : 's'} not in from Octopus yet.`));
    notes.append(el('li', 'muted', 'VAT added to Octopus’s ex-VAT costs by date (domestic rate).'));
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
        this.data.impDays, this.data.impCover, this.data.expDays, this.data.expCover);
      const head = el('div', 'day-head');
      head.append(
        el('strong', null, `${DOW[new Date(`${k}T12:00:00Z`).getUTCDay()]} ${d} ${MON[m - 1]}`),
        el('span', 'muted', ` ${s.kwh.toFixed(2)} kWh · ${pounds(s.total)}${s.missing ? ` · ${s.missing} missing` : ''}`
          + `${s.uncostedSlots ? ` · ${s.uncostedSlots} not costed yet` : ''}`),
      );
      const holder = el('div', 'day-chart');
      holder.append(el('canvas'));
      box.append(head, holder);
      wrap.append(box);
      this.observer.observe(box);
    }
    return wrap;
  }

  drawDay(box, k) {
    const slots = [...slotsOfDay(k)].sort((a, b) => a - b);
    const day = this.data.impDays.get(k);
    const eday = this.data.expDays?.get(k);
    const rates = rateLine(k, day, slots, this.data.publishedFor(k));
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const grid = dark ? '#2a2d3a' : '#e5e7eb', text = dark ? '#c9ccd6' : '#444';
    const datasets = [{
      type: 'bar', label: 'Import kWh', yAxisID: 'kwh', order: 2,
      data: slots.map((s) => day?.get(s)?.kwh ?? null),
      backgroundColor: slots.map((s) => (day?.get(s)?.offPeak === true ? '#2e9e5b' : '#3b6fd8')),
    }];
    if (eday) {
      datasets.push({ type: 'bar', label: 'Export kWh', yAxisID: 'kwh', order: 3,
        data: slots.map((s) => (eday.get(s) ? -eday.get(s).kwh : null)), backgroundColor: '#e0a020' });
    }
    datasets.push({
      type: 'line', label: 'Rate p/kWh', yAxisID: 'rate', order: 1,
      data: slots.map((s) => rates.get(s)), stepped: 'middle', borderColor: '#cc0000', borderWidth: 1.5,
      pointRadius: 0, spanGaps: false,
    });
    const chart = new Chart(box.querySelector('canvas'), {
      data: { labels: slots.map(fmtSlot), datasets },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, ticks: { color: text, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { color: grid } },
          kwh: { position: 'left', stacked: true, title: { display: true, text: 'kWh', color: text }, ticks: { color: text }, grid: { color: grid } },
          rate: { position: 'right', beginAtZero: true, title: { display: true, text: 'p/kWh', color: text }, ticks: { color: text }, grid: { display: false } },
        },
        plugins: {
          legend: { labels: { color: text, boxWidth: 12 } },
          tooltip: { callbacks: { label: (c) => (c.parsed.y == null ? null
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
  }
}

