// Light or dark. The page follows the device until EMT's logo is clicked, as in EMT; the choice is
// then kept on this device (localStorage, "light" or "dark", nothing else) and applied before the
// first paint by public/theme.js.
export const THEME_KEY = 'emt_lite_theme';
const media = () => globalThis.matchMedia?.('(prefers-color-scheme: dark)');

export function isDark(root = globalThis.document?.documentElement) {
  const t = root?.dataset.theme;
  return t ? t === 'dark' : Boolean(media()?.matches);
}

/** Switch to the other theme, keep the choice, and tell the charts to redraw. */
export function toggleTheme(root = globalThis.document?.documentElement) {
  const t = isDark(root) ? 'light' : 'dark';
  root.dataset.theme = t;
  try { globalThis.localStorage?.setItem(THEME_KEY, t); } catch { /* storage blocked: this visit only */ }
  globalThis.document?.dispatchEvent(new Event('emt-lite-theme'));
  return t;
}

/** Call fn when the theme changes: the device's, or a click on the logo. */
export function onThemeChange(fn) {
  media()?.addEventListener?.('change', fn);
  globalThis.document?.addEventListener('emt-lite-theme', fn);
}
