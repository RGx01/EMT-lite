// The data heatmap (design §1): EMT's net kWh heatmap. A canvas per local month, a row per day, a
// square per local half-hour, coloured by import − export with EMT's colour stops
// (heatmap_module.html kwhStops / paint): above zero white → orange → red, below zero
// white → green → blue.
//
// Gaps are hatched over the cell (cellOf):
//   black and white      no import reading (and no export reading to show instead)
//   green over colour    the export reading is missing; the colour is the import alone
//   red over colour      the import reading is missing; the colour is the export alone
// Blank: not in yet, before the supply started, or a half-hour the clocks skipped.

import { daysBetween, slotsOfDay, parseKey } from './time.js';
import { slotState } from './bill.js';

const CELL = 16, GAP = 1, LEFT = 34, TOP = 40, TOTAL_W = 120, PAD = 10;
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const HATCH = { bw: ['#000000', '#ffffff'], green: [null, '#00c853'], red: [null, '#ff1744'] };

const dark = () => window.matchMedia?.('(prefers-color-scheme: dark)').matches;
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
  const impSt = slotState(imp, dayKey, slot, impCover);
  const expSt = exp ? slotState(exp, dayKey, slot, expCover) : 'none';
  const i = impSt === 'present' ? imp.get(dayKey).get(slot).kwh : null;
  const e = expSt === 'present' ? exp.get(dayKey).get(slot).kwh : null;
  const out = { value: null, hatch: null, imp: i, exp: e, impSt, expSt };
  if (impSt === 'future') return out;
  if (i != null) {
    out.value = i - (e ?? 0);
    if (expSt === 'missing') out.hatch = 'green';
  } else if (impSt === 'missing') {
    if (e != null) { out.value = -e; out.hatch = 'red'; } else out.hatch = 'bw';
  } else if (e != null) {
    out.value = -e;                     // import not in yet, or before its supply: the export alone
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
  x.beginPath(); x.moveTo(-1, 7); x.lineTo(7, -1); x.moveTo(-1, 1); x.lineTo(1, -1); x.moveTo(5, 7); x.lineTo(7, 5); x.stroke();
  return (_hatches[kind] = ctx.createPattern(c, 'repeat'));
}

const fmtSlot = (s) => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;
const kwh = (v) => `${v.toFixed(3)} kWh`;

/** Draw `months` (oldest first, [{start,end}]) into `root`. */
export function renderHeatmap(root, { months, imp, impCover, exp, expCover }) {
  root.replaceChildren();
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
  root.append(legend(stops, mn, mx, !!exp));

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
    ctx.fillText('Net kWh/day', totX, TOP - 8);

    let missImp = 0, missExp = 0;
    const hit = [];
    rows.forEach((r, row) => {
      const yy = TOP + row * (CELL + GAP);
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
        if (c.impSt === 'missing') missImp++;
        if (c.expSt === 'missing') missExp++;
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
    if (missImp) parts.push(`${missImp} import`);
    if (missExp) parts.push(`${missExp} export`);
    note.textContent = parts.length ? `${parts.join(', ')} half-hour${missImp + missExp === 1 ? '' : 's'} missing` : '';

    canvas.addEventListener('mousemove', (ev) => {
      const b = canvas.getBoundingClientRect();
      const px = ev.clientX - b.left, py = ev.clientY - b.top;
      const q = hit.find((z) => px >= z.x && px < z.x + CELL && py >= z.y && py < z.y + CELL);
      if (!q) { tip.hidden = true; return; }
      const { c } = q;
      const say = (st, v) => (st === 'present' ? kwh(v) : st === 'missing' ? 'missing' : st === 'pending' ? 'not in yet'
        : st === 'outside' ? 'before supply' : st === 'future' ? '—' : '');
      const bits = [`${q.k} ${fmtSlot(q.s)}`, `import ${say(c.impSt, c.imp)}`];
      if (exp) bits.push(`export ${say(c.expSt, c.exp)}`);
      if (c.value != null && exp) bits.push(`net ${kwh(c.value)}`);
      tip.textContent = bits.join(' · ');
      tip.hidden = false;
      tip.style.left = `${ev.pageX + 12}px`;
      tip.style.top = `${ev.pageY + 12}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
}

function legend(stops, mn, mx, withExport) {
  const el = document.createElement('div');
  el.className = 'hm-legend';
  const bar = document.createElement('canvas');
  bar.width = 200; bar.height = 12;
  const x = bar.getContext('2d');
  for (let i = 0; i < 200; i++) { x.fillStyle = paint(stops, 0, 199, i); x.fillRect(i, 0, 1, 12); }
  const span = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; return s; };
  el.append(span(`${mn.toFixed(2)} kWh`), bar, span(`${mx.toFixed(2)} kWh${withExport ? ' (import − export)' : ''}`));
  el.append(span('', 'hm-swatch bw'), span(withExport ? 'no import or export reading' : 'no reading from Octopus'));
  if (withExport) {
    el.append(span('', 'hm-swatch green'), span('export missing'));
    el.append(span('', 'hm-swatch red'), span('import missing'));
  }
  return el;
}
