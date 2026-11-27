// The theme picked by clicking EMT's logo (src/theme.js), applied before the page paints so a dark
// choice never flashes light. With no choice the page follows the device. Not bundled: a plain
// script from public/, so it runs before the stylesheet's first paint.
try {
  const t = localStorage.getItem('emt_lite_theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* storage blocked: follow the device */ }
