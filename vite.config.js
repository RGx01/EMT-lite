import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The production headers live in public/_headers (Cloudflare Pages). `npm run preview`
// serves the built page with the same headers, so a CSP violation shows up locally.
function headersFromFile() {
  const out = {};
  for (const line of readFileSync(new URL('./public/_headers', import.meta.url), 'utf8').split('\n')) {
    const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export default defineConfig({
  build: { target: 'es2022', sourcemap: false },
  preview: { port: 4173, strictPort: true, headers: headersFromFile() },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
