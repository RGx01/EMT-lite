// The data heatmap (design §1): EMT's net kWh heatmap. A canvas per local month, a row per day, a
// square per local half-hour, coloured by import − export with EMT's colour stops
// (heatmap_module.html kwhStops / paint): above zero white → orange → red, below zero
// white → green → blue.
//
// Gaps are hatched over the cell (cellOf):
//   black and white      no import reading (and no export reading to show instead)
//   green / over colour  the export reading is missing; the colour is the import alone
//   red \ over colour    the import reading is missing; the colour is the export alone
// Green and red slant opposite ways, so they differ without red-green colour vision.
// Blank: not in yet, before the supply started, or a half-hour the clocks skipped.

import { daysBetween, slotsOfDay, parseKey } from './time.js';
import { slotState } from './bill.js';
import { isDark as dark } from './theme.js';

const CELL = 16, GAP = 1, LEFT = 34, TOP = 40, TOTAL_W = 120, PAD = 10;
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HATCH = { bw: ['#000000', '#ffffff'], green: [null, '#00c853'], red: [null, '#ff1744'] };

const bg = () => (dark() ? '#1a1d27' : '#ffffff');
const axis = () => (dark() ? '#9aa0b0' : '#555566');

function hex(c) { c = c.replace('#', ''); return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16)); }

export function kwhStops(mn, mx, W = '#ffffff') {
  if (mx === mn) mx = mn + 1;
  const wp = Math.max(0, Math.min(1, (0 - mn) / (mx - mn)));
  if (wp <= 0.01) return [[0, W], [0.33, '#ffcc99'], [0.66, '#ff6600'], [1, '#cc0000']];
  if (wp >= 0.99) return [[0, '#003366'], [0.33, '#0066cc'], [0.66, '#00aa66'], [1, W]];
  return [[0, '#003366'], [wp * 0.33, '#0066cc'], [wp * 0.66, '#00aa66'], [wp, W],
    [wp + (1 - wp) * 0.33, '#ffcc99'], [wp + (1 - wp) * 0.66, '#ff6600'], [1, '#cc0000']];
}

export function paint(stops, mn, mx, v) {
  let t = mx > mn ? (v - mn) / (mx - mn) : 0.5;
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0] || i === stops.length - 1) {
      const a = stops[i - 1], b = stops[i], span = b[0] - a[0];
      const u = span > 0 ? Math.min(1, (t - a[0]) / span) : 0;
      const A = hex(a[1]), B = hex(b[1]);
      return `rgb(${[0, 1, 2].map((k) => Math.round(A[k] + (B[k] - A[k]) * u)).join(',')})`;
    }
  }
  return stops.at(-1)[1];
}

/**
 * One half-hour of the net grid. `exp` / `expCover` are null without an export meter.
 * Returns { value: net kWh | null, hatch: null | 'bw' | 'green' | 'red', imp, exp, impSt, expSt }.
 */
export function cellOf(imp, impCover, exp, expCover, dayKey, slot) {
  // A finished half-hour Octopus has no reading for is hatched, whether or not it is merely late
  // ('pending'): the heatmap shows what Octopus holds now, today included.
  const gap = (st) => (st === 'pending' ? 'missing' : st);
  const impSt = gap(slotState(imp, dayKey, slot, impCover));
  const expSt = exp ? gap(slotState(exp, dayKey, slot, expCover)) : 'none';
  // 'partial' (the clocks-back hour with one of two readings): its value counts, and it is hatched
  // as missing on that side.
  const has = (st) => st === 'present' || st === 'partial';
  const i = has(impSt) ? imp.get(dayKey).get(slot).kwh : null;
  const e = has(expSt) ? exp.get(dayKey).get(slot).kwh : null;
  const out = { value: null, hatch: null, imp: i, exp: e, impSt, expSt };
  if (impSt === 'future') return out;
  const expGap = expSt === 'missing' || expSt === 'partial';
  if (i != null) {
    out.value = i - (e ?? 0);
    if (impSt === 'partial') out.hatch = expGap || e == null ? 'bw' : 'red';
    else if (expGap) out.hatch = 'green';
  } else if (impSt === 'missing') {
    if (e != null) { out.value = -e; out.hatch = expSt === 'partial' ? 'bw' : 'red'; } else out.hatch = 'bw';
  } else if (e != null) {
    out.value = -e;                     // import not in yet, or before its supply: the export alone
    if (expSt === 'partial') out.hatch = 'green';
  } else if (expSt === 'missing') {
    out.hatch = 'green';
  }
  return out;
}

const _hatches = {};
function hatch(ctx, kind) {
  if (_hatches[kind]) return _hatches[kind];
  const [base, line] = HATCH[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const x = c.getContext('2d');
  if (base) { x.fillStyle = base; x.fillRect(0, 0, 6, 6); }
  x.strokeStyle = line; x.lineWidth = kind === 'bw' ? 1.2 : 1.6;
  x.beginPath();
  if (kind === 'red') {      // the other slant, so red and green differ without colour vision
    x.moveTo(-1, -1); x.lineTo(7, 7); x.moveTo(5, -1); x.lineTo(7, 1); x.moveTo(-1, 5); x.lineTo(1, 7);
  } else {
    x.moveTo(-1, 7); x.lineTo(7, -1); x.moveTo(-1, 1); x.lineTo(1, -1); x.moveTo(5, 7); x.lineTo(7, 5);
  }
  x.stroke();
  return (_hatches[kind] = ctx.createPattern(c, 'repeat'));
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MON = MON.map((m) => m.slice(0, 3));

/** One day's totals from its cells (cellOf): kWh imported and exported where read, and the
 *  half-hours missing on each side. */
export function daySummary(cells) {
  const d = { imp: 0, exp: 0, impN: 0, expN: 0, missImp: 0, missExp: 0, net: null };
  for (const c of cells) {
    if (!c) continue;
    if (c.impSt === 'present' || c.impSt === 'partial') { d.imp += c.imp; d.impN++; }
    if (c.expSt === 'present' || c.expSt === 'partial') { d.exp += c.exp; d.expN++; }
    if (c.impSt === 'missing' || c.impSt === 'partial') d.missImp++;
    if (c.expSt === 'missing' || c.expSt === 'partial') d.missExp++;
    if (c.value != null) d.net = (d.net ?? 0) + c.value;
  }
  return d;
}

/** The tooltip on a day's net bar. `unit` and `what` name the readings: kWh and import for
 *  electricity, the gas meter's unit and gas for gas. */
export function dayBarText(k, d, withExport, unit = 'kWh', what = 'import') {
  const { y, m, d: dd } = parseKey(k);
  const dow = DOW[new Date(Date.UTC(y, m - 1, dd)).getUTCDay()];
  const bits = [`${dow} ${dd} ${SHORT_MON[m - 1]} ${y}`];
  if (d.net == null) bits.push('no readings');
  else {
    bits.push(withExport ? `net ${d.net.toFixed(2)} ${unit}` : `${d.net.toFixed(2)} ${unit}`);
    if (withExport) bits.push(`import ${d.imp.toFixed(2)} kWh`, `export ${d.exp.toFixed(2)} kWh`);
  }
  const miss = [];
  if (d.missImp) miss.push(`${d.missImp} ${what}`);
  if (withExport && d.missExp) miss.push(`${d.missExp} export`);
  if (miss.length) bits.push(`${miss.join(', ')} half-hour${d.missImp + (withExport ? d.missExp : 0) === 1 ? '' : 's'} missing`);
  return bits.join(' · ');
}

const fmtSlot = (s) => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;

/** Draw `months` (oldest first, [{start,end}]) into `root`. */
export function renderHeatmap(root, { months, imp, impCover, exp, expCover, unit = 'kWh', what = 'import' }) {
  root.replaceChildren();
  const kwh = (v) => `${v.toFixed(3)} ${unit}`;
  const grids = months.map((month) => {
    const rows = daysBetween(month.start, month.end).map((k) => {
      const exists = slotsOfDay(k);
      const cells = [];
      let total = 0, any = false;
      for (let s = 0; s < 48; s++) {
        if (!exists.has(s)) { cells.push(null); continue; }
        const c = cellOf(imp, impCover, exp, expCover, k, s);
        if (c.value != null) { total += c.value; any = true; }
        cells.push(c);
      }
      return { k, cells, total: any ? total : null };
    });
    return { month, rows };
  });

  // one scale over everything loaded, so months compare
  let mn = 0, mx = 0, maxAbsDay = 0;
  for (const g of grids) {
    for (const r of g.rows) {
      for (const c of r.cells) if (c?.value != null) { mn = Math.min(mn, c.value); mx = Math.max(mx, c.value); }
      if (r.total != null) maxAbsDay = Math.max(maxAbsDay, Math.abs(r.total));
    }
  }
  const stops = kwhStops(mn, mx, bg());
  root.append(legend(stops, mn, mx, !!exp, unit));

  const tip = document.createElement('div');
  tip.className = 'hm-tip';
  tip.hidden = true;
  root.append(tip);

  const anyNeg = mn < 0;
  for (const { month, rows } of [...grids].reverse()) {
    const { y, m } = parseKey(month.start);
    const W = LEFT + 48 * (CELL + GAP) + PAD + TOTAL_W + PAD;
    const H = TOP + rows.length * (CELL + GAP) + PAD;
    const wrap = document.createElement('section');
    wrap.className = 'hm-month';
    const h = document.createElement('h3');
    h.textContent = `${MON[m - 1]} ${y}`;
    const note = document.createElement('span');
    note.className = 'hm-note';
    h.append(' ', note);
    const canvas = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    canvas.setAttribute('role', 'img');
    wrap.append(h, canvas);
    root.append(wrap);

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = axis();
    for (let s = 0; s < 48; s += 4) {
      ctx.save();
      ctx.translate(LEFT + s * (CELL + GAP) + CELL / 2, TOP - 6);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(fmtSlot(s), 0, 0);
      ctx.restore();
    }
    const totX = LEFT + 48 * (CELL + GAP) + PAD;
    const zeroX = anyNeg ? totX + TOTAL_W / 2 : totX;
    const barScale = maxAbsDay > 0 ? (anyNeg ? TOTAL_W / 2 : TOTAL_W) / maxAbsDay : 0;
    ctx.fillText(exp || unit === 'kWh' && what === 'import' ? `Net ${unit}/day` : `${unit}/day`, totX, TOP - 8);

    let missImp = 0, missExp = 0;
    const hit = [], bars = [];
    rows.forEach((r, row) => {
      const yy = TOP + row * (CELL + GAP);
      bars.push({ y: yy, text: dayBarText(r.k, daySummary(r.cells), !!exp, unit, what) });
      const dow = new Date(`${r.k}T12:00:00Z`).getUTCDay();
      const weekend = dow === 0 || dow === 6;
      ctx.fillStyle = weekend ? (dark() ? '#e8eaf0' : '#1d2130') : axis();
      ctx.font = `${weekend ? '600 ' : ''}10px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(String(parseKey(r.k).d), LEFT - 6, yy + CELL - 4);
      ctx.textAlign = 'left';
      ctx.font = '10px system-ui, sans-serif';
      r.cells.forEach((c, s) => {
        if (!c) return;
        const xx = LEFT + s * (CELL + GAP);
        if (c.impSt === 'missing' || c.impSt === 'partial') missImp++;
        if (c.expSt === 'missing' || c.expSt === 'partial') missExp++;
        if (c.value != null) {
          ctx.fillStyle = paint(stops, mn, mx, c.value);
          ctx.fillRect(xx, yy, CELL, CELL);
        }
        if (c.hatch) {
          ctx.fillStyle = hatch(ctx, c.hatch);
          ctx.fillRect(xx, yy, CELL, CELL);
        }
        hit.push({ k: r.k, s, c, x: xx, y: yy });
      });
      if (r.total != null && barScale) {
        const w = r.total * barScale;
        ctx.fillStyle = r.total >= 0 ? (dark() ? '#e0794a' : '#d9622b') : (dark() ? '#45b37a' : '#2e9e5b');
        ctx.fillRect(w >= 0 ? zeroX : zeroX + w, yy + 2, Math.abs(w), CELL - 4);
      }
    });
    if (anyNeg) {
      ctx.fillStyle = axis();
      ctx.fillRect(zeroX, TOP - 2, 1, rows.length * (CELL + GAP));
    }
    const parts = [];
    if (missImp) parts.push(`${missImp} ${what}`);
    if (missExp) parts.push(`${missExp} export`);
    note.textContent = parts.length ? `${parts.join(', ')} half-hour${missImp + missExp === 1 ? '' : 's'} missing` : '';

    canvas.addEventListener('mousemove', (ev) => {
      const b = canvas.getBoundingClientRect();
      const px = ev.clientX - b.left, py = ev.clientY - b.top;
      const show = (text) => {
        tip.textContent = text;
        tip.hidden = false;
        // near the right edge (the day bars are there), it goes to the left of the pointer
        const right = ev.clientX + 12 + tip.offsetWidth > document.documentElement.clientWidth - 8;
        tip.style.left = `${right ? ev.pageX - 12 - tip.offsetWidth : ev.pageX + 12}px`;
        tip.style.top = `${ev.pageY + 12}px`;
      };
      // the day's net bar: anywhere across its column, so a short bar is easy to find
      if (px >= totX && px < totX + TOTAL_W) {
        const bar = bars.find((z) => py >= z.y && py < z.y + CELL + GAP);
        if (bar) { show(bar.text); return; }
      }
      const q = hit.find((z) => px >= z.x && px < z.x + CELL && py >= z.y && py < z.y + CELL);
      if (!q) { tip.hidden = true; return; }
      const { c } = q;
      const say = (st, v) => (st === 'present' ? kwh(v) : st === 'partial' ? `${kwh(v)}, one of the hour's two readings missing (clocks back)` : st === 'missing' ? 'missing' : st === 'pending' ? 'not in yet'
        : st === 'outside' ? 'before supply' : st === 'future' ? '—' : '');
      const bits = [`${q.k} ${fmtSlot(q.s)}`, `${what} ${say(c.impSt, c.imp)}`];
      if (exp) bits.push(`export ${say(c.expSt, c.exp)}`);
      if (c.value != null && exp) bits.push(`net ${kwh(c.value)}`);
      show(bits.join(' · '));
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
}

function legend(stops, mn, mx, withExport, unit = 'kWh') {
  const el = document.createElement('div');
  el.className = 'hm-legend';
  const bar = document.createElement('canvas');
  bar.width = 200; bar.height = 12;
  const x = bar.getContext('2d');
  for (let i = 0; i < 200; i++) { x.fillStyle = paint(stops, 0, 199, i); x.fillRect(i, 0, 1, 12); }
  const span = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; return s; };
  el.append(span(`${mn.toFixed(2)} ${unit}`), bar, span(`${mx.toFixed(2)} ${unit}${withExport ? ' (import − export)' : ''}`));
  el.append(span('', 'hm-swatch bw'), span(withExport ? 'no import or export reading' : 'no reading from Octopus'));
  if (withExport) {
    el.append(span('', 'hm-swatch green'), span('export missing (/)'));
    el.append(span('', 'hm-swatch red'), span('import missing (\\)'));
  }
  return el;
}
