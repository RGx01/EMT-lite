# EMT-Lite

Octopus Energy bills and a missing-data heatmap, drawn in the browser from your API key. The key
goes from your browser to `api.octopus.energy` and nowhere else: the page is static files, and its
Content-Security-Policy lets it connect only to Octopus.

The design is [docs/design.md](docs/design.md).

## Running it

```bash
npm install
npm test            # unit tests (Vitest)
npm run build       # static output in dist/
npm run preview     # serves dist/ on :4173 with the production headers from public/_headers
```

`npm run dev` serves the source with hot reload but **without** the CSP. Check anything
security-related with `build` + `preview`.

**Try the demo** on the sign-in page loads a made-up account through the same code a real one uses.

## Deploying

The site is a Cloudflare Pages project, `emt-lite`, served at <https://emt-lite.pages.dev/>. It is
uploaded with Wrangler, not built by Cloudflare from GitHub. Deploy from a clean checkout of `main`:

```bash
npx wrangler login   # once per machine
npm run deploy       # refuses uncommitted changes; tests, builds, uploads dist/ tagged with the commit
```

`public/_headers` is copied into `dist/` and becomes the live response headers (CSP and the rest).
After a deploy, check them:

```bash
curl -sI https://emt-lite.pages.dev/ | grep -i content-security-policy
```

The project was created as a **classic Pages project** (`wrangler pages project create emt-lite
--production-branch main --force`). Without `--force`, Wrangler 4.168 converts the repository into a
Cloudflare Worker, rewriting `package.json` and the Vite config; that is not wanted here. The project
exists now, so later commands need no `--force`.

## Layout

| file | what |
|---|---|
| `src/octopus.js` | the only code that talks to Octopus: token, account, measurements, Agile rates |
| `src/data.js` | picks meters and the billing rule; loads months newest first |
| `src/measurements.js` | Octopus measurement nodes → half-hours (pence, ex VAT) |
| `src/time.js`, `src/vat.js` | UK local time; VAT by date |
| `src/periods.js`, `src/bill.js`, `src/rates.js` | period cutting, the bill card's arithmetic, the rate line |
| `src/heatmap.js`, `src/bills.js`, `src/main.js` | the two views and the page |
| `src/demo.js` | the demo account |
| `public/_headers` | Cloudflare Pages response headers (CSP and the rest) |

## Licence

PolyForm Noncommercial 1.0.0, as EMT.
