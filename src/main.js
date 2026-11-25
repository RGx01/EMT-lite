import { Octopus } from './octopus.js';
import { AccountData, describeAccount, monthsToLoad, DEFAULT_MONTHS } from './data.js';
import { anchorFromBillingDay } from './periods.js';
import { todayKey } from './time.js';
import { DemoOctopus, demoAccountInfo } from './demo.js';
import { BillsView } from './bills.js';
import { renderHeatmap } from './heatmap.js';

// "Remember me" (design §4.4): Octopus's refresh token, the account number and a billing day the
// user entered. Never the key. Nothing else is written to the browser.
const STORE = 'emt-lite';
const remembered = () => { try { return JSON.parse(localStorage.getItem(STORE)) || null; } catch { return null; } };
const remember = (v) => localStorage.setItem(STORE, JSON.stringify(v));
const forget = () => localStorage.removeItem(STORE);

const $ = (id) => document.getElementById(id);
let octo = null, data = null, bills = null, tab = 'bills', keep = false, monthsWanted = DEFAULT_MONTHS;

function showError(msg) {
  const e = $('error');
  e.textContent = msg;
  e.hidden = !msg;
}

function status(msg) { $('status').textContent = msg || ''; }

function setTab(t) {
  tab = t;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('active', b.dataset.tab === t);
  $('view-bills').hidden = t !== 'bills';
  $('view-heatmap').hidden = t !== 'heatmap';
  redraw();
}

let pending = false;
function redraw() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    if (!data) return;
    if (tab === 'bills') bills.render();
    else {
      renderHeatmap($('heatmap'), {
        months: monthsToLoad(data.loaded.length).reverse(),
        imp: data.impDays, impCover: data.impCover,
        exp: data.info.export ? data.expDays : null, expCover: data.info.export ? data.expCover : null,
      });
    }
  });
}

function signedIn(who) {
  $('signin').hidden = true;
  $('app').hidden = false;
  $('tabs').hidden = false;
  $('forget').hidden = false;
  $('who').textContent = who;
}

function signOut() {
  forget();
  octo?.signOut?.();
  bills?.destroyCharts();
  octo = data = bills = null;
  $('key').value = '';
  $('app').hidden = true;
  $('tabs').hidden = true;
  $('forget').hidden = true;
  $('who').textContent = '';
  $('signin').hidden = false;
  $('heatmap').replaceChildren();
  $('view-bills').replaceChildren();
}

async function pickAccount(numbers) {
  if (numbers.length <= 1) return numbers[0] || null;
  const saved = remembered()?.account;
  if (saved && numbers.includes(saved)) return saved;
  const box = $('account-pick');
  box.replaceChildren();
  const label = document.createElement('label');
  label.textContent = 'Which account? ';
  const sel = document.createElement('select');
  for (const n of numbers) { const o = document.createElement('option'); o.value = o.textContent = n; sel.append(o); }
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'Show';
  label.append(sel);
  box.append(label, ok);
  box.hidden = false;
  return new Promise((resolve) => ok.addEventListener('click', () => { box.hidden = true; resolve(sel.value); }, { once: true }));
}

function persist(extra = {}) {
  if (!keep || !octo?.refreshToken) return;
  remember({ ...(remembered() || {}), rt: octo.refreshToken, rtExp: octo.refreshExp, ...extra });
}

async function start(info) {
  const user = remembered()?.billingDay;
  if (user) {
    info.billing = { anchor: anchorFromBillingDay(user, todayKey()), months: 1, source: 'user' };
  }
  data = new AccountData(octo, info);
  bills = new BillsView($('view-bills'), data, {
    onBillingDay: (day) => {
      data.info.billing = { anchor: anchorFromBillingDay(day, todayKey()), months: 1, source: 'user' };
      if (keep) remember({ ...(remembered() || {}), billingDay: day });
    },
  });
  await loadMonths(monthsToLoad(monthsWanted));
}

async function loadMonths(months) {
  $('more').hidden = true;
  const todo = months.filter((m) => !data.loaded.includes(m.start));
  for (let i = 0; i < todo.length; i++) {
    try {
      await data.loadMonth(todo[i], (what) => status(`Loading ${what} (${i + 1} of ${todo.length})…`));
    } catch (e) {
      status(`Stopped: ${e.message}`);
      return;
    }
    redraw();
  }
  const exp = octo?.refreshExp ? new Date(octo.refreshExp * 1000) : null;
  status(keep && exp ? `Up to date. Remembered on this device until ${exp.toLocaleDateString('en-GB')}.` : 'Up to date.');
  $('more').hidden = false;
}

async function signInAndLoad(signIn) {
  showError('');
  octo = new Octopus();
  octo.onTokens = () => persist();
  try {
    await signIn(octo);
    const numbers = await octo.accountNumbers();
    if (!numbers.length) throw new Error('This key has no Octopus accounts.');
    signedIn('');
    const number = await pickAccount(numbers);
    persist({ account: number });
    status('Reading your account…');
    const acc = await octo.accountInfo(number);
    const info = describeAccount(number, acc);
    if (!info.import) throw new Error('No electricity import meter on this account.');
    const recent = await octo.recentBills(number).catch(() => []);
    info.evidence = { options: acc.billingOptions || null, bills: recent };
    // An account's statements need not close on a fixed day: when there are statements, they are
    // the bill periods (design §5.2).
    if (recent.some((b) => String(b.billType || '').toUpperCase() === 'STATEMENT')) {
      info.billing = { statements: recent, options: acc.billingOptions || null, source: 'statements' };
    }
    $('who').textContent = number;
    await start(info);
  } catch (e) {
    signOut();
    showError(e.message || String(e));
  }
}

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  keep = $('remember').checked;
  const key = $('key').value;
  $('key').value = '';
  signInAndLoad((o) => o.signInWithKey(key));
});

$('demo').addEventListener('click', async () => {
  showError('');
  keep = false;
  octo = new DemoOctopus();
  signedIn('Demo account (made-up figures)');
  await start(demoAccountInfo());
});

$('forget').addEventListener('click', signOut);
$('more').addEventListener('click', () => {
  monthsWanted += 12;
  loadMonths(monthsToLoad(monthsWanted));
});
for (const b of document.querySelectorAll('#tabs .tab')) b.addEventListener('click', () => setTab(b.dataset.tab));
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', redraw);

// A remembered device signs in with its refresh token.
const saved = remembered();
if (saved?.rt && (!saved.rtExp || saved.rtExp * 1000 > Date.now())) {
  keep = true;
  $('remember').checked = true;
  signInAndLoad((o) => o.signInWithRefreshToken(saved.rt));
} else if (saved) {
  forget();
}

