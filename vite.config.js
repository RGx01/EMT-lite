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

// The version in the footer (CHANGELOG.md): package.json's, and on the dev preview the commit too, so
// a report from there says which build it came from. scripts/deploy.sh sets EMT_LITE_CHANNEL and
// EMT_LITE_COMMIT; a local build shows the version alone.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const channel = process.env.EMT_LITE_CHANNEL || '';
const commit = (process.env.EMT_LITE_COMMIT || '').slice(0, 7);
const version = `v${pkg.version}${channel === 'dev' ? ` · dev${commit ? ` ${commit}` : ''}` : ''}`;

export default defineConfig({
  define: { __EMT_LITE_VERSION__: JSON.stringify(version) },
  build: { target: 'es2022', sourcemap: false },
  preview: { port: 4173, strictPort: true, headers: headersFromFile() },
  server: { port: 5173, strictPort: true },
  test: { environment: 'node', include: ['tests/**/*.test.js'] },
});
