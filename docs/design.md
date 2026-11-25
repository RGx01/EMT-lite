# EMT-Lite — billing charts and a missing-data heatmap in the browser

*Design, 25 Nov 2026. **Draft — not decided, not built.** Almost everything it knows about Octopus,
EMT learned first: a file named here without a repository (`kraken_api_client.py`,
`web/templates/heatmap_module.html`, …) is in [RGx01/EMT](https://github.com/RGx01/EMT).
This repository is private while the design is drafted, and goes public before the first user
enters a key (§2).*

---

## 1. What it is

A web page for an Octopus customer **without Home Assistant**. They paste their API key and see:

1. **Bills.** The bill for each billing period: total, energy, standing charge, off-peak and peak
   split. Under it, one chart a day with the half-hours' kWh as bars and the rate charged as a
   stepped line. The periods are cut the way EMT's Billing tab cuts them (`web/templates/billing_module.html`):
   Bill / Month / Quarter / Year, with *vs previous* and *vs last year*.
2. **A data heatmap.** EMT's kWh heatmap (`web/templates/heatmap_module.html`): one row per day, one
   square per local half-hour, a month per chart. A half-hour that Octopus has **no reading for** is
   drawn **black and white hatched**.

What it is not: no live power, no devices or EV split, no Data Management, no corrections, no bill
PDFs, no carbon. It shows what Octopus holds, and the gaps in it.

### 1.1 Missing is not zero

The hatch means *Octopus returned no interval for this half-hour*. A reading of `0.000 kWh` is real
data (solar covering the house, a house standing empty) and is drawn as the lightest colour, not
hatched. Keeping the two apart is the point of the heatmap: hatched squares are the reason a bill
can be short.

Local-time rules come from EMT's heatmap: the clocks-forward hour does not exist and is left blank,
**not** hatched; the repeated clocks-back hour is summed into its slot.

## 2. The trust model: the key never leaves the browser

The page is **static files with no server-side code**. The browser calls Octopus directly. This
was checked on 25 Nov 2026: `api.octopus.energy/v1/graphql/` and the REST endpoints answer with
`Access-Control-Allow-Origin: *`, allow the `authorization` and `content-type` headers, and allow
`POST`.

So the key goes from the user's browser to `api.octopus.energy` and nowhere else. EMT-Lite's host
never sees it, never logs it, and has nothing to leak. That is what the page tells the user, in one
line beside the key field, and the open source code lets them check it.

An Octopus API key is not read-only. Through GraphQL it reaches the whole account. This is why
§4 matters and why §8 rejects every design with a server in the path.

## 3. Hosting

Static hosting, free tier. Any of these will do:

| host | for | against |
|---|---|---|
| **Cloudflare Pages** (proposed) | free with no commercial-use limit; a `_headers` file sets CSP and the rest per path; deploys from a GitHub repo | one more account |
| GitHub Pages | the repository is already there | **cannot set response headers**: CSP only by `<meta>`, which cannot carry `frame-ancestors` |
| Vercel | easy; `vercel.json` sets headers | Hobby (free) is non-commercial only; its strength (functions) is what we do not want |
| Netlify | `_headers` like Cloudflare | no advantage over Cloudflare here |

**Proposed: Cloudflare Pages**, built from the EMT-Lite repository's `main`. A custom domain is
optional. The `*.pages.dev` address works.

## 4. Security

1. **Content-Security-Policy**, as a response header:
   `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
   connect-src https://api.octopus.energy; font-src 'self'; frame-ancestors 'none';
   base-uri 'none'; form-action 'none'`.
   `connect-src` is the key line: even code injected into the page could not send the key anywhere
   but Octopus.
2. **No third-party code at runtime.** No analytics, no CDN. EMT loads Chart.js and
   `chartjs-chart-matrix` from cdnjs and jsDelivr; EMT-Lite **bundles** them, pinned with a
   lockfile. Every dependency is reviewed when it is bumped.
3. **The key is swapped for a token at once.** `obtainKrakenToken(input: {APIKey})` returns a token
   (about an hour) and a refresh token. The page keeps the token and refresh token **in memory**
   and drops the key. Closing the tab forgets everything.
4. **"Remember me" is opt-in** and says what it does: the *refresh token* (not the key) in
   `localStorage`, with a "Forget me" button that clears it and the cache (§6). *Open: whether to
   offer this at all (§9).*
5. **Nothing reaches the URL.** Not the key, account, MPAN or dates: they would land in history and
   in `Referer`. Also `Referrer-Policy: no-referrer`.
6. Other headers: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
   `Permissions-Policy` denying everything.
7. **The page never calls a mutation** except `obtainKrakenToken` and its refresh. This is
   enforced in code: the one GraphQL helper refuses any other mutation.
8. **No user content is rendered as HTML.** Octopus strings such as tariff names go in with
   `textContent`, never `innerHTML`.

## 5. Data from Octopus

Everything below is EMT's own experience (`kraken_api_client.py`). The schema facts were checked by
introspection on 25 Nov 2026.

### 5.1 Who and what

- **Account:** `viewer { accounts { number } }`. The key is enough. If there is more than one
  account, the user picks one.
- **Meters:** the account's electricity meter points, with their agreements. Import is required,
  export is optional (§9). The active meter is picked as EMT's `_pick_active_meter` does, and the
  agreement in force as `_current_agreement` does (never a zero-length blip, v5 #53).

### 5.2 The billing day

`account.billingOptions` carries `periodStartDay`, `periodLength` (`MONTHLY` | `QUARTERLY`),
`periodLengthMultiplier`, `isFixed`, `currentBillingPeriodStartDate` and
`currentBillingPeriodEndDate`.

1. If `periodLength` is `MONTHLY` and `periodStartDay` is set, use it. *Not yet tried with a real
   key: the first job when built.*
2. If not, take the start day of `account.bills`.
3. If neither works, ask the user, store the answer with the cache (§6), and let them change it.

`QUARTERLY` bills: the Bill view cuts quarters from `currentBillingPeriodStartDate`. *Open (§9).*

### 5.3 The half-hours, with their cost

One query does it all: GraphQL `measurements` with
`readingFrequencyType: THIRTY_MIN_INTERVAL` and `timezone: "Europe/London"` (EMT's
`get_measurements`). Each interval carries kWh, Octopus's `OFF_PEAK` / `STANDARD_RATE` label (the
dispatch-aware split on Intelligent tariffs), `costExclTax`, `costInclTax` and the standing charge
per interval.

What EMT learned the hard way, which EMT-Lite starts with:

- **Ask exact local months**, from local midnight on the 1st. A padded window comes back with
  **no cost**, and narrow windows mislabel the middle of a long smart charge.
- If a month leaves half-hours without a cost, ask those **local days**. If a day still leaves
  some, ask noon to noon (EMT's `recover_measurement_costs`). If that still leaves any, they are
  shown as *kWh, no cost from Octopus*.
- **Page size 500.** A month is about 1,490 intervals, so 3 pages.
- **VAT:** compute the VAT-inclusive cost from `costExclTax` and EMT's VAT calendar
  (`vat_calendar.py`: 5% up to 30 Sep 2026, 0% from 1 Oct 2026, at local midnight).
  **Do not use `costInclTax`**: Octopus's half-hourly figures carried 5% after the change (v4
  #505).

The REST `/consumption/` endpoint is not needed: `measurements` has the kWh too. *Open: whether
REST is cheaper against the rate limit for heatmap-only months (§9).*

### 5.4 Rate limits

Kraken limits by query points per hour, **per account**, so each user spends their own. EMT's
experience is that the limit is shared by everything using the account. A user running EMT, or
Octopus's app, takes from the same pot.

- Requests go one at a time, paced, with EMT's backoff on the rate-limit error `KT-CT-1199`.
- Months come **newest first**. The page is useful after the first answer and fills backwards.
- **History depth defaults to 13 months** (enough for *vs last year*). "Load more" goes further.

## 6. Cache

Per account, in **IndexedDB on the user's device**: each month's intervals, with when they were
fetched. A month that has fully settled is kept. The current month and the month before it are
re-fetched on each visit, because Octopus fills them in late. Nothing is stored unless the user
opted in to *Remember me* (§4.4). Otherwise it is memory only, gone with the tab. "Forget me"
deletes the database.

## 7. Building it

- **Plain JavaScript modules and Vite**, producing static output. No framework: two views do not
  need one, and every dependency is attack surface (§4.2).
- **Chart.js 4 and `chartjs-chart-matrix`**, as EMT uses. The heatmap and day charts start as
  ports of `heatmap_module.html` and `billing_module.html`, with the EMT-only parts removed:
  corrections, settlement states, devices, carbon, PDF.
- **Hatching:** a canvas pattern (`createPattern` from a small black-and-white diagonal tile) as
  the cell's fill. EMT's heatmap already draws its "no block" cells this way.
- **The bill card's arithmetic** lives in one pure module with unit tests: periods, totals,
  standing charge, VAT, off-peak and peak. In EMT that is Python (`bill_card.py`,
  `billing_view.py`). In EMT-Lite it is JavaScript, so it has its own tests.
- **Tests:** Vitest for the arithmetic and period cutting, with recorded (fictional) Octopus
  answers as fixtures. One Playwright check confirms the built page loads under its CSP with no
  violations.
- **Licence:** PolyForm Noncommercial, as EMT.

## 8. Rejected

- **A server or serverless proxy** (Vercel Functions, Cloudflare Workers). It would only be needed
  for CORS, which Octopus already allows (§2), and it would put every user's key through
  infrastructure we run. That is the one thing this design exists to avoid.
- **Storing keys server-side for scheduled fetches or e-mailed reports.** Same reason.
- **Asking for the account number.** `viewer.accounts` finds it.
- **`costInclTax` as the bill.** See §5.3.
- **A backend database of users' data.** IndexedDB on their device is enough.

## 9. Open questions

1. *Remember me:* offer it (refresh token in `localStorage`), or memory-only always?
2. Export (`GENERATION`) in v1? It adds a second fetch per month and an export line on the bill.
3. Quarterly billing: cut from `currentBillingPeriodStartDate`, or leave it out of v1?
4. Fixed-rate and Agile accounts: the day chart's rate line comes from cost ÷ kWh per
   half-hour. Is that good enough, or fetch the tariff's published rates?
5. Name and domain.
6. Should the heatmap's cell show the kWh value or a *how complete* tint? Proposed: kWh, as EMT.
