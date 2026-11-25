// The page under its production headers: the CSP is served, nothing it loads breaks it, and it
// cannot reach any host but Octopus (design §4). The demo runs the whole page without a key.
import { test, expect } from '@playwright/test';

// Hosts the page may load from: itself, and Home Assistant's badge image (img-src).
const ALLOWED = new Set(['localhost:4174', 'my.home-assistant.io']);

function watch(page) {
  const seen = { errors: [], hosts: new Set(), violations: [] };
  page.on('console', (m) => { if (m.type() === 'error') seen.errors.push(m.text()); });
  page.on('pageerror', (e) => seen.errors.push(String(e)));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) seen.hosts.add(u.host); });
  return seen;
}

async function violations(page) {
  return page.evaluate(() => window.__csp || []);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
});

test('the page is served with its CSP and the other security headers', async ({ page }) => {
  const res = await page.goto('/');
  const h = res.headers();
  expect(h['content-security-policy']).toContain("connect-src https://api.octopus.energy;");
  expect(h['content-security-policy']).toContain("script-src 'self';");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['referrer-policy']).toBe('no-referrer');
});

test('the demo runs with no CSP violation, no error, and no request to another host', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the demo' }).click();
  await expect(page.locator('#status')).toContainText('Up to date', { timeout: 30_000 });
  await expect(page.locator('.bill-card')).toBeVisible();
  await page.locator('.day canvas').first().scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Heatmap' }).click();
  await expect(page.locator('.hm-month canvas').first()).toBeVisible();
  await page.locator('.hm-month canvas').first().hover();
  // the demo has a gas meter: its heatmap too
  await page.getByRole('button', { name: 'Gas' }).click();
  await expect(page.locator('.hm-legend')).toContainText('kWh');
  await page.locator('.hm-month canvas').first().hover();

  expect(await violations(page)).toEqual([]);
  expect(seen.errors).toEqual([]);
  expect([...seen.hosts].filter((h) => !ALLOWED.has(h))).toEqual([]);
});

test('a request to any host but Octopus is blocked', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(() => fetch('https://example.com/').then(() => 'sent', () => 'blocked'));
  expect(result).toBe('blocked');
  expect((await violations(page)).some((v) => v.startsWith('connect-src https://example.com'))).toBe(true);
});
