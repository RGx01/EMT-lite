import { Octopus } from './octopus.js';
import { AccountData, describeAccount, monthsToLoad, provisionalMonths, DEFAULT_MONTHS, billingFromDay, chooseBilling } from './data.js';
import { DemoOctopus, demoAccountInfo, DEMO_NUMBER } from './demo.js';
import { deviceCache, deleteDeviceCache } from './cache.js';
import { BillsView } from './bills.js';
import { renderHeatmap } from './heatmap.js';

// The page's header bar stays at the top; the bills' own bar sticks just below it (--top-h).
{
  const top = document.querySelector('.top');
  const setTop = () => document.documentElement.style.setProperty('--top-h', `${top.offsetHeight}px`);
  new ResizeObserver(setTop).observe(top);
  setTop();
}

// The footer's version (vite.config.js), linking to CHANGELOG.md.
document.getElementById('version').textContent = typeof __EMT_LITE_VERSION__ === 'string' ? __EMT_LITE_VERSION__ : '';

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
  $('view-heatmap').hidden = t !== 'heatmap' && t !== 'gas';   // both heatmaps draw in one place
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
      if (tab === 'gas' && data.info.gas) {
        // gas: its half-hours only, no export and no bill (design §1)
        renderHeatmap($('heatmap'), {
          months: data.shownMonths().reverse(),
          imp: data.gasDays, impCover: data.gasCover, exp: null, expCover: null,
          unit: data.gasUnit, what: 'gas',
        });
      } else {
        renderHeatmap($('heatmap'), {
          months: data.shownMonths().reverse(),
          imp: data.impDays, impCover: data.impCover,
          exp: data.info.export ? data.expDays : null, expCover: data.info.export ? data.expCover : null,
        });
      }
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

/** Forget this device: the remembered token and billing days, and the month cache. */
async function forgetDevice() {
  forget();
  await data?.cache?.close?.();
  await deleteDeviceCache();
}

/** Sign out: forget the device, and back to the sign-in page. */
async function signOut() {
  session++;                      // abandons a sign-in still running
  await forgetDevice();
  resetPage();
}

/** Back to the sign-in page, keeping what this device remembers (after an error). */
function resetPage() {
  $('tab-gas').hidden = true;
  if (tab === 'gas') setTab('bills');
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

async function start(o, info) {
  // the device cache only when the user asked to be remembered, and never for the demo
  const cache = keep && info.number !== DEMO_NUMBER ? deviceCache() : null;
  data = new AccountData(o, info, cache);
  $('tab-gas').hidden = !info.gas;            // Gas Heatmap only for an account with a gas meter
  bills = new BillsView($('view-bills'), data, {
    // A day the user chooses holds for this visit, and is remembered with the account when the
    // browser is remembering it (design §4.4).
    onBillingDay: (day) => {
      data.info.billing = billingFromDay(day, 'user');
      if (keep && info.number !== DEMO_NUMBER) {
        const r = remembered() || {};
        remember({ ...r, billingDays: { ...(r.billingDays || {}), [info.number]: data.info.billing.day } });
      }
    },
  });
  await loadMonths(monthsToLoad(monthsWanted));
}

// Months load MONTHS_AT_ONCE at a time, newest first. The calls are the same ones, so the
// account's rate limit is spent no faster; they overlap Octopus's seconds-long answers.
const MONTHS_AT_ONCE = 3;

// When the data was last asked of Octopus, and whether a load is running: coming back to the page
// an hour or more later asks again for the months holding the provisional days (design §6.1).
const REFRESH_AFTER_MS = 3600000;
let fetchedAt = 0, loading = false;

async function loadMonths(months) {
  loading = true;
  try { await loadMonthsNow(months); } finally { loading = false; fetchedAt = Date.now(); }
}

async function refreshRecent() {
  const mine = data;
  if (!mine || loading || Date.now() - fetchedAt < REFRESH_AFTER_MS) return;
  const months = provisionalMonths(mine.loaded);
  if (!months.length) return;
  loading = true;
  status('Updating the last few days from Octopus…');
  try {
    for (const m of months) { await mine.refreshMonth(m); if (data !== mine) return; }
    redraw();
    status('Up to date.');
  } catch (e) {
    if (data === mine) status(`Could not update: ${e.message || e}`);
  } finally { loading = false; fetchedAt = Date.now(); }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshRecent(); });

async function loadMonthsNow(months) {
  $('more').hidden = true;
  const todo = months.filter((m) => !data.loaded.includes(m.start));
  let next = 0, done = 0, fromDevice = 0, failed = null;
  const mine = data;
  status(`Loading ${todo.length} month${todo.length === 1 ? '' : 's'} from Octopus…`);
  const worker = async () => {
    while (next < todo.length && !failed && data === mine) {
      const m = todo[next++];
      try {
        if ((await mine.loadMonth(m)) === 'device') fromDevice++;
      } catch (e) {
        failed = failed || e;
        return;
      }
      done++;
      status(`Loaded ${done} of ${todo.length} months…`);
      redraw();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MONTHS_AT_ONCE, todo.length) }, worker));
  if (data !== mine) return;                  // signed out meanwhile
  if (failed) { status(`Stopped: ${failed.message}`); return; }
  const exp = octo?.refreshExp ? new Date(octo.refreshExp * 1000) : null;
  const kept = fromDevice ? ` ${fromDevice} settled month${fromDevice === 1 ? '' : 's'} from this device, ${todo.length - fromDevice} from Octopus.` : '';
  status((keep && exp ? `Up to date. Remembered on this device until ${exp.toLocaleDateString('en-GB')}.` : 'Up to date.') + kept);
  $('more').hidden = false;
}

// Each sign-in (a key, a remembered token, the demo) is its own session: a later one abandons an
// earlier one still running, which then changes nothing. Before, they shared one client, and a
// click on Try the demo mid-sign-in sent the real sign-in on with the demo's.
let session = 0;
const busy = (on) => { for (const b of [$('demo'), document.querySelector('#key-form [type=submit]')]) b.disabled = on; };

async function signInAndLoad(signIn) {
  showError('');
  const my = ++session;
  const o = new Octopus();
  o.onTokens = () => { if (my === session) persist(); };
  octo = o;
  busy(true);
  try {
    await signIn(o);
    if (my !== session) return;
    const numbers = await o.accountNumbers();
    if (my !== session) return;
    if (!numbers.length) throw new Error('This key has no Octopus accounts.');
    signedIn('');
    const number = await pickAccount(numbers);
    persist({ account: number });
    status('Reading your account…');
    const acc = await o.accountInfo(number);
    if (my !== session) return;
    const info = describeAccount(number, acc);
    if (!info.import) throw new Error('No electricity import meter on this account.');
    // Kraken's billing trigger, if the account has one, is a source for the billing day (design §5.2).
    const trigger = await o.billingTrigger(number).catch(() => null);
    if (my !== session) return;
    info.billing = chooseBilling({ userDay: remembered()?.billingDays?.[number] ?? null, info, trigger });
    $('who').textContent = number;
    busy(false);
    await start(o, info);
  } catch (e) {
    if (my !== session) return;
    resetPage();
    showError(e.message || String(e));
  } finally {
    if (my === session) busy(false);
  }
}

$('key-form').addEventListener('submit', (e) => {
  e.preventDefault();
  keep = $('remember').checked;
  // not remembering: nothing from an earlier remembered visit stays on this device
  if (!keep) forgetDevice();
  const key = $('key').value;
  $('key').value = '';
  signInAndLoad((o) => o.signInWithKey(key));
});

$('demo').addEventListener('click', async () => {
  showError('');
  session++;                      // abandons a sign-in still running
  keep = false;
  const o = new DemoOctopus();
  octo = o;
  signedIn('Demo account (made-up figures)');
  await start(o, demoAccountInfo());
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
  forgetDevice();                 // the remembered sign-in has expired: forget its cache with it
}

