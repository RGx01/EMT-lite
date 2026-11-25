// The Bills view (design §1): a period picker (Bill / Month / Quarter / Year), the bill card with
// vs previous and vs last year, and a chart per day: kWh as bars, the charged rate as a stepped line.

import {
  Chart, BarController, BarElement, LineController, LineElement, PointElement,
  LinearScale, CategoryScale, Tooltip, Legend,
} from 'chart.js';
import { billPeriods, calendarPeriods, previousOf, lastYearOf, periodLabel } from './periods.js';
import { summarise, pounds } from './bill.js';
import { rateLine, solid, sideRateLine, exportRateLine } from './rates.js';
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
    this.prompt = null;          // the billing-day form, while open: { value, focus }
    this.evidenceOpen = false;
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
    const bar = el('div', 'bills-bar');
    for (const [m, lab] of MODES) {
      const b = el('button', `mode${m === this.mode ? ' active' : ''}`, lab);
      b.type = 'button';
      b.addEventListener('click', () => { this.mode = m; this.sel = null; this.render(); });
      bar.append(b);
    }
    this.root.append(bar);

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
      const nth = ordinal(this.data.info.billing.day);
      const why = src === 'octopus' ? `billing day ${nth}, from Octopus` : src === 'trigger' ? `billing day ${nth}, from Octopus’s billing trigger`
        : src === 'demo' ? `demo billing day ${nth}` : src === 'user' ? `billing day ${nth}, your choice`
        : `billing day ${nth}: Octopus does not say, so the 1st`;
      const change = el('button', 'link', `${why} · change`);
      change.type = 'button';
      change.addEventListener('click', () => {
        this.prompt = { value: String(this.data.info.billing?.day ?? 1), focus: true };
        nav.after(this.billingDayPrompt());
      });
      nav.append(change);
    }
    this.root.append(nav);
    // a redraw (each month that loads) keeps an open form and fold-out as they were
    if (this.mode === 'bill' && this.prompt) nav.after(this.billingDayPrompt());
    if (this.mode === 'bill' && this.data.info.evidence) this.root.append(this.evidence());

    const d = this.data;
    const sum = (q) => q && summarise(q, d.impDays, d.impCover, d.expDays, d.expCover);
    const s = sum(p), sp = sum(previousOf(list, p)), sy = sum(lastYearOf(list, p));
    this.root.append(this.card(p, s, sp, sy));
    this.root.append(this.days(p));
  }

  /** What Octopus holds about billing, so the billing day can be traced to its source. */
  evidence() {
    const { options: o, trigger: t, payments: ps = [], bills: bs = [] } = this.data.info.evidence;
    const box = el('details', 'evidence');
    box.open = !!this.evidenceOpen;
    box.addEventListener('toggle', () => { this.evidenceOpen = box.open; });
    box.append(el('summary', null, 'What Octopus says about your billing'));
    const lines = el('ul');
    const li = (text) => lines.append(el('li', null, text));
    li(o ? `Billing options: start day ${o.periodStartDay ?? 'not set'}, ${String(o.periodLength ?? '—').toLowerCase()}`
      + `; current period from ${o.currentBillingPeriodStartDate ?? '—'}` : 'Billing options: none');
    if (t?.error) {
      li(`Billing trigger: could not be read (${t.error})`);
    } else if (t) {
      const fs = (t.operationFrequencies || []).map((f) => `${String(f.operationType).toLowerCase()} ${String(f.frequency).toLowerCase()}`
        + ` on day ${f.triggerAtStartDay}`);
      li(`Billing trigger${t.isActive === false ? ' (inactive)' : ''}: ${fs.join('; ') || 'no frequencies'}; next issue ${t.nextIssueDate ?? '—'}`);
    } else {
      li('Billing trigger: none');
    }
    for (const p of ps) li(`Payment schedule: day ${p.paymentDay ?? '—'}, ${String(p.paymentFrequency ?? '').toLowerCase()} (not used as the billing day)`);
    for (const b of bs.slice(0, 3)) li(`${String(b.billType || 'Bill').toLowerCase()}: ${b.fromDate} to ${b.toDate ?? '—'}`);
    box.append(lines);
    return box;
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
    const row = (a, b, c = '', cls = null) => {
      const tr = el('tr', cls);
      tr.append(el('th', null, a), el('td', null, b), el('td', 'num', c));
      t.append(tr);
    };
    const kwh = (v) => `${v.toFixed(1)} kWh`;
    const rate = (b) => (b.kwh > 0 ? ` @ ${(b.cost / b.kwh).toFixed(2)}p` : '');
    if (s.offPeak.kwh) row('Off-peak', kwh(s.offPeak.kwh) + rate(s.offPeak), pounds(s.offPeak.cost));
    if (s.peak.kwh) row('Peak', kwh(s.peak.kwh) + rate(s.peak), pounds(s.peak.cost));
    if (s.unbanded.kwh) row('Energy', kwh(s.unbanded.kwh) + rate(s.unbanded), pounds(s.unbanded.cost));
    if (s.split) {
      const head = el('tr', 'sub-head');
      const th = el('th', null, 'Octopus’s House / EV split');
      th.colSpan = 3;
      head.append(th);
      t.append(head);
      const NAMES = { ev: 'EV', home: 'House' }, BANDS = { off: 'off-peak', peak: 'peak', other: '' };
      for (const band of ['off', 'peak', 'other']) {
        for (const side of ['ev', 'home']) {
          const e = s.split[`${side}:${band}`];
          if (!e || (e.kwh < 0.0005 && Math.abs(e.cost) < 0.005)) continue;
          row(`${NAMES[side]} ${BANDS[band]}`.trim(), kwh(e.kwh) + rate(e), pounds(e.cost));
        }
      }
    }
    row('Standing charge', `${s.days} day${s.days === 1 ? '' : 's'}${s.finished ? '' : ' so far'}`, pounds(s.standing));
    row('Import total', kwh(s.kwh), pounds(s.total), 'total');
    if (s.exportKwh) row('Export', kwh(s.exportKwh), `−${pounds(s.exportCredit)}`);
    card.append(t);

    const notes = el('ul', 'bill-notes');
    if (s.missing) notes.append(el('li', 'warn', `${s.missing} half-hour${s.missing === 1 ? '' : 's'} with no reading from Octopus: this bill will look short. See the heatmap.`));
    if (s.uncostedSlots) notes.append(el('li', 'warn', `${s.uncostedKwh.toFixed(2)} kWh in ${s.uncostedSlots} half-hour${s.uncostedSlots === 1 ? '' : 's'} not costed by Octopus yet.`));
    if (s.unsplitSlots) notes.append(el('li', 'warn', `${s.unsplitSlots} costed half-hour${s.unsplitSlots === 1 ? '' : 's'} without Octopus’s House/EV split yet: the split rows add up to less than the energy.`));
    if (s.split) notes.append(el('li', 'muted', 'Octopus can revise its House/EV split for some days after it first appears.'));
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
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const grid = dark ? '#2a2d3a' : '#e5e7eb', text = dark ? '#c9ccd6' : '#444';
    const iv = (s) => day?.get(s);
    const bar = (label, color, value) => ({ type: 'bar', label, yAxisID: 'kwh', order: 2, stack: 'kwh',
      backgroundColor: color, data: slots.map(value) });
    const line = (label, color, rates) => ({ type: 'line', label, yAxisID: 'rate', order: 1,
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
      datasets.push(line('House rate p/kWh', text, sideRateLine(k, day, slots, 'home')));
      if (slots.some((s) => (iv(s)?.split?.['ev:off']?.kwh || 0) + (iv(s)?.split?.['ev:peak']?.kwh || 0) > 0)) {
        // wider and beneath the House line: where the two rates are the same, it shows as an edge
        datasets.push({ ...line('EV rate p/kWh', PALETTE.evRate, sideRateLine(k, day, slots, 'ev')), order: 1.5, borderWidth: 6 });
      }
    } else {
      datasets.push(
        bar('Import off-peak', PALETTE.houseOff, (s) => (iv(s)?.offPeak === true ? iv(s).kwh : null)),
        bar('Import peak', PALETTE.housePeak, (s) => (iv(s) && iv(s).offPeak !== true ? iv(s).kwh : null)),
        line('Rate p/kWh', text, solid(rateLine(k, day, slots, this.data.publishedFor(k)), slots)),
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


function ordinal(n) {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suf}`;
}
