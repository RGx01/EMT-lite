// The data heatmap (design §1): a canvas per local month, a row per day, a square per local
// half-hour, coloured by kWh with EMT's colour stops (heatmap_module.html kwhStops / paint).
// Black with grey diagonals: Octopus has no reading for the half-hour. Blank: not in yet, before
// the supply started, or (clocks-forward day) a half-hour that does not exist.

import { daysBetween, slotsOfDay, parseKey } from './time.js';
import { slotState } from './bill.js';

const CELL = 16, GAP = 1, LEFT = 34, TOP = 40, TOTAL_W = 110, PAD = 10;
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

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

let _hatch = null;
function hatch(ctx) {
  if (_hatch) return _hatch;
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 6, 6);
  x.strokeStyle = '#ffffff'; x.lineWidth = 1.2;
  x.beginPath(); x.moveTo(-1, 7); x.lineTo(7, -1); x.moveTo(-1, 1); x.lineTo(1, -1); x.moveTo(5, 7); x.lineTo(7, 5); x.stroke();
  return (_hatch = ctx.createPattern(c, 'repeat'));
}

const fmtSlot = (s) => `${String(Math.floor(s / 2)).padStart(2, '0')}:${s % 2 ? '30' : '00'}`;

/**
 * Draw `months` (oldest first, [{start,end}]) into `root`.
 * `days`: byDay() map; `cover`: slotState's cover; `label`: 'Import' | 'Export'.
 */
export function renderHeatmap(root, { months, days, cover, label }) {
  root.replaceChildren();
  // one scale over everything loaded, so months compare
  let mn = 0, mx = 0, maxDay = 0;
  for (const [, d] of days) {
    let tot = 0;
    for (const [, iv] of d) { mn = Math.min(mn, iv.kwh); mx = Math.max(mx, iv.kwh); tot += iv.kwh; }
    maxDay = Math.max(maxDay, tot);
  }
  const stops = kwhStops(mn, mx, bg());
  root.append(legend(stops, mn, mx));

  const tip = document.createElement('div');
  tip.className = 'hm-tip';
  tip.hidden = true;
  root.append(tip);

  let missingTotal = 0;
  for (const month of [...months].reverse()) {
    const { y, m } = parseKey(month.start);
    const ks = daysBetween(month.start, month.end);
    const W = LEFT + 48 * (CELL + GAP) + PAD + TOTAL_W + PAD;
    const H = TOP + ks.length * (CELL + GAP) + PAD;
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
    ctx.fillStyle = axis();
    ctx.font = '10px system-ui, sans-serif';
    for (let s = 0; s < 48; s += 4) {
      ctx.save();
      ctx.translate(LEFT + s * (CELL + GAP) + CELL / 2, TOP - 6);
      ctx.rotate(-Math.PI / 4);
      ctx.fillText(fmtSlot(s), 0, 0);
      ctx.restore();
    }
    ctx.fillText(`${label} kWh/day`, LEFT + 48 * (CELL + GAP) + PAD, TOP - 8);

    let missing = 0;
    const cells = [];
    ks.forEach((k, row) => {
      const yy = TOP + row * (CELL + GAP);
      const dow = new Date(`${k}T12:00:00Z`).getUTCDay();
      const weekend = dow === 0 || dow === 6;
      ctx.fillStyle = weekend ? (dark() ? '#e8eaf0' : '#1d2130') : axis();
      ctx.font = `${weekend ? '600 ' : ''}10px system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(String(parseKey(k).d), LEFT - 6, yy + CELL - 4);
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      const exists = slotsOfDay(k);
      const day = days.get(k);
      let tot = 0;
      for (let s = 0; s < 48; s++) {
        const xx = LEFT + s * (CELL + GAP);
        if (!exists.has(s)) continue;
        const st = slotState(days, k, s, cover);
        if (st === 'present') {
          const v = day.get(s).kwh;
          tot += v;
          ctx.fillStyle = paint(stops, mn, mx, v);
          ctx.fillRect(xx, yy, CELL, CELL);
          if (v === 0) { ctx.strokeStyle = axis(); ctx.globalAlpha = 0.25; ctx.strokeRect(xx + 0.5, yy + 0.5, CELL - 1, CELL - 1); ctx.globalAlpha = 1; }
        } else if (st === 'missing') {
          missing++;
          ctx.fillStyle = hatch(ctx);
          ctx.fillRect(xx, yy, CELL, CELL);
        }
        cells.push({ k, s, st, x: xx, y: yy });
      }
      if (tot > 0 && maxDay > 0) {
        ctx.fillStyle = dark() ? '#5b8def' : '#3b6fd8';
        const bw = (tot / maxDay) * TOTAL_W;
        ctx.fillRect(LEFT + 48 * (CELL + GAP) + PAD, yy + 2, bw, CELL - 4);
      }
    });
    missingTotal += missing;
    note.textContent = missing ? `${missing} half-hour${missing === 1 ? '' : 's'} missing` : '';

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const c = cells.find((q) => px >= q.x && px < q.x + CELL && py >= q.y && py < q.y + CELL);
      if (!c) { tip.hidden = true; return; }
      const iv = days.get(c.k)?.get(c.s);
      const what = c.st === 'present' ? `${iv.kwh.toFixed(3)} kWh`
        : c.st === 'missing' ? 'no reading from Octopus' : c.st === 'pending' ? 'not in yet' : 'before the supply started';
      tip.textContent = `${c.k} ${fmtSlot(c.s)} · ${what}`;
      tip.hidden = false;
      tip.style.left = `${e.pageX + 12}px`;
      tip.style.top = `${e.pageY + 12}px`;
    });
    canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  }
  return { missing: missingTotal };
}

function legend(stops, mn, mx) {
  const el = document.createElement('div');
  el.className = 'hm-legend';
  const bar = document.createElement('canvas');
  bar.width = 200; bar.height = 12;
  const x = bar.getContext('2d');
  for (let i = 0; i < 200; i++) { x.fillStyle = paint(stops, 0, 199, i); x.fillRect(i, 0, 1, 12); }
  const lo = document.createElement('span'), hi = document.createElement('span');
  lo.textContent = `${mn.toFixed(2)} kWh`;
  hi.textContent = `${mx.toFixed(2)} kWh`;
  const sw = document.createElement('span');
  sw.className = 'hm-swatch';
  const miss = document.createElement('span');
  miss.textContent = 'no reading from Octopus (missing)';
  el.append(lo, bar, hi, sw, miss);
  return el;
}

