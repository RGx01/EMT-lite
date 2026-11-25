# EMT-Lite — billing charts and a missing-data heatmap in the browser

*Design, 25 Nov 2026. **Being built** (first pass 25 Nov 2026, §10). Its six open questions were decided on 25 Nov 2026 (§9). Almost everything it knows about Octopus,
EMT learned first: a file named here without a repository (`kraken_api_client.py`,
`web/templates/heatmap_module.html`, …) is in [RGx01/EMT](https://github.com/RGx01/EMT).
This repository was private while the design was drafted, and went public on 25 Nov 2026, before
anyone but its author entered a key (§2).*

---

## 1. What it is

A web page for an Octopus customer **without Home Assistant**. They paste their API key and see:

1. **Bills.** The bill for each billing period: total, energy, standing charge, off-peak and peak
   split. Under it, one chart a day with the half-hours' kWh as bars and the rate charged as a
   stepped line. The periods are cut the way EMT's Billing tab cuts them (`web/templates/billing_module.html`):
   Bill / Month / Quarter / Year, with *vs previous* and *vs last year*. As in EMT: a **header bar**
   that stays at the top (period, stepper, *Show Data*); once the bill has scrolled away, a
   one-line **bill strip** in it with *↑ Show Bill*; each day's half-hours as a **data table**
   (its own *☰ Data* button, or all at once from the header), with the standing charge and the
   day's total under it; legend and hover keys drawn as a line for a rate, a block for a bar.
2. **A data heatmap.** EMT's kWh heatmap (`web/templates/heatmap_module.html`): one row per day, one
   square per local half-hour, a month per chart, coloured by **net** kWh (import − export) with
   EMT's colour stops, and the daily net as bars beside it: one grid, as EMT's kWh heatmap.
   Hovering a cell gives its import, export and net; hovering a day's bar (anywhere across the bar
   column, so a short bar is easy to hit) gives the day's net, import, export and missing half-hours.
   A half-hour Octopus has **no reading for** is hatched over its cell: **green** where the export
   reading is missing (the colour is the import alone), **red** where the import is missing (the
   colour is the export alone), **black and white** where neither is there, or the import is
   missing on an account without export. Green and red slant opposite ways (`/` and `\`), so they
   differ without red-green colour vision. A finished half-hour with no reading is hatched even
   when it is only late, today included: the heatmap shows what Octopus holds now. Decided
   25 Nov 2026, replacing an Import / Export toggle.
3. **The House / EV split** on an IOG-SMB tariff: Octopus's own split, from the kWh and cost of
   each of its buckets (EMT's `bucket_side`), as rows on the bill card. A half-hour with a bucket
   label it does not recognise is left unsplit, not guessed, and the card says how many. The day
   charts stack each bucket as its own bar, with a solid rate line for the House and one for the
   EV (§5.5).

**Around the page.** The page's own header bar (EMT-Lite, the account, Bills / Heatmap, Sign out)
stays at the top on every view; the bills' bar sticks just under it. On a wide screen the header
bar also says *Got Home Assistant? Try EMT for a richer experience*, linking EMT on GitHub, with
Home Assistant's own *Add app repository to My* badge linking to its add-repository page for EMT. The footer bar, always in view at the bottom of
the window, carries the same, for narrow screens,
and a link to this repository's issues, for problems and suggestions.

**Colours** are Okabe–Ito, distinguishable with red-green colour blindness: House off-peak / peak
sky blue / blue, EV off-peak / peak orange / vermillion, export bluish green, the EV rate reddish
purple, the House rate the text colour.

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
| **Cloudflare Pages** (decided) | free with no commercial-use limit; a `_headers` file sets CSP and the rest per path; deploys from a GitHub repo | one more account |
| GitHub Pages | the repository is already there | **cannot set response headers**: CSP only by `<meta>`, which cannot carry `frame-ancestors` |
| Vercel | easy; `vercel.json` sets headers | Hobby (free) is non-commercial only; its strength (functions) is what we do not want |
| Netlify | `_headers` like Cloudflare | no advantage over Cloudflare here |

**Decided: Cloudflare Pages**, launched as **EMT-Lite** on its free address,
<https://emt-lite.pages.dev/> (live 25 Nov 2026). A custom domain can be added later without changing
anything else.

**Built:** a classic Pages project, `emt-lite`, uploaded from a clean checkout of `main` with
`npm run deploy` (Wrangler direct upload), not built by Cloudflare from GitHub: the site matches a
commit that was tested here, and Cloudflare needs no access to the repository. The live headers match
`public/_headers`.

## 4. Security

1. **Content-Security-Policy**, as a response header:
   `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://my.home-assistant.io;
   connect-src https://api.octopus.energy; font-src 'self'; frame-ancestors 'none';
   base-uri 'none'; form-action 'none'`.
   `connect-src` is the key line: even code injected into the page could not send the key anywhere
   but Octopus. `img-src` also allows `my.home-assistant.io`, for Home Assistant's official
   *Add app repository to My* badge on the EMT advert, linked as EMT's README links it: the
   visitor's browser fetches that image (no referrer), and an image request cannot carry the key.
2. **No third-party code at runtime.** No analytics, no CDN. EMT loads Chart.js and
   `chartjs-chart-matrix` from cdnjs and jsDelivr; EMT-Lite **bundles** them, pinned with a
   lockfile. Every dependency is reviewed when it is bumped.
3. **The key is swapped for a token at once.** `obtainKrakenToken(input: {APIKey})` returns a token
   (about an hour) and a refresh token. The page keeps the token and refresh token **in memory**
   and drops the key. Closing the tab forgets everything.
4. **"Remember me" is an opt-in tickbox** and says what it does: it stores the *refresh token*
   (never the key) in `localStorage`, with a "Forget me" button that clears it and the cache (§6).
   When the refresh token expires, the user pastes the key again. *Its lifetime is not known yet:
   check it with a real key when built, and state it beside the tickbox.* Rejected: storing the key
   encrypted under a passphrase, which adds a password to forget and more code for little gain.
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
- **Meters:** the account's electricity meter points, with their agreements. Import is required.
  **Export is fetched only when the account has an export meter point**, so an import-only account
  pays no extra calls. With export, the bill gets an export credit line. The active meter is picked as EMT's `_pick_active_meter` does, and the
  agreement in force as `_current_agreement` does (never a zero-length blip, v5 #53).

### 5.2 The billing day

`account.billingOptions` carries `periodStartDay`, `periodLength` (`MONTHLY` | `QUARTERLY`),
`periodLengthMultiplier`, `isFixed`, `currentBillingPeriodStartDate` and
`currentBillingPeriodEndDate`.

**The billing day (decided 25 Nov 2026).** In order:

1. A day the user chose on the page. It holds for the visit, and is stored with the account when
   *Remember me* is on (§4.4).
2. `billingOptions.periodStartDay`.
3. A monthly `billingTriggerConfiguration.operationFrequencies[].triggerAtStartDay` (Kraken's
   "day of the month when billing is triggered").
4. The 1st.

Not used: `currentBillingPeriodStartDate` and the statements' dates. On the first real account
tried, the user's billing day was the 3rd while Octopus held no start day and no billing trigger,
its current period began on a different day, and its statements closed on different days each
month. The payment schedule's `paymentDay` is the Direct Debit day, not the billing day. The page
does not fetch or show any of these. A panel that listed them (*What Octopus says about your
billing*) was dropped on 25 Nov 2026 as not useful.

**Monthly and quarterly use one rule.** Bill periods step from the billing day in `periodLength` ×
`periodLengthMultiplier` months (monthly unless Octopus says otherwise).

### 5.3 The half-hours, with their cost

One query does it all: GraphQL `measurements` with
`readingFrequencyType: THIRTY_MIN_INTERVAL` and `timezone: "Europe/London"` (EMT's
`get_measurements`). Each interval carries kWh, Octopus's `OFF_PEAK` / `STANDARD_RATE` label (the
dispatch-aware split on Intelligent tariffs), `costExclTax`, `costInclTax` and the standing charge
per interval.

What EMT learned the hard way, which EMT-Lite starts with:

- **Ask windows of whole local days, at most 10** (25 Nov 2026), each starting and ending at a
  local midnight. A padded window comes back with **no cost**, and narrow windows mislabel the
  middle of a long smart charge. Small asks are what EMT found reliable: its 60-day asks timed
  out where 30-day ones landed. Ten days is at most 482 half-hours, one 500-row page.
- **Recover what a window leaves without a cost**, in EMT's order (`recover_measurement_costs`):
  each half-hour's local **day**, then its local **month**, then **noon to noon** (the previous
  noon to this noon before midday, else this noon to the next). On some days Octopus costs nothing
  in any window that *starts* at that day's midnight, whatever its end; a window with no costs at
  all is therefore recovered too. Not asked: the last three days (not priced yet) and days before
  the supply started. What is still left is shown as *kWh, no cost from Octopus*. On the first
  real account, August to October left 175–366 half-hours a month without a cost; recovery
  costed all of them, about a quarter by the month and noon to noon after the day.
- **Page size 500.**
- **VAT:** compute the VAT-inclusive cost from `costExclTax` and EMT's VAT calendar
  (`vat_calendar.py`: 5% up to 30 Sep 2026, 0% from 1 Oct 2026, at local midnight).
  **Do not use `costInclTax`**: Octopus's half-hourly figures carried 5% after the change (v4
  #505).
- **Business VAT** (built 25 Nov 2026). Kraken's `account.accountType` is `BUSINESS…` for a business
  account. Such an account pays the rate its import tariff carries (standing charge inc VAT ÷
  `preVatStandingCharge`; every tariff type has both). The rate comes from the agreement in force
  now, else the latest, snapped to a statutory rate (0, 5 or 20%). If no tariff shows one, the
  standard 20% is used. That one rate applies to every day loaded, because the calendar's 0% from
  1 Oct 2026 is domestic. The bill card says which rate was added and why.

The REST `/consumption/` endpoint is not needed: `measurements` has the kWh too. *Still open:
whether REST is cheaper against the rate limit for months that are only needed for the heatmap
(§9).*

### 5.5 The rate line

The day chart's rate for each half-hour is what Octopus charged:
`costExclTax ÷ kWh`, with VAT added from the calendar (§5.3).

- **A half-hour with no kWh** has no cost to divide, and nothing in it carries a label, so it has no
  band. On an **Intelligent** tariff (a product code with `INTELLI`, without Octopus's House/EV
  split) it takes the day's off-peak rate inside IOG's 23:30–05:30 window and the day's peak rate
  outside it. After a dispatch ends, a half-hour that drew nothing is back at peak; until 26 Nov 2026
  it carried the dispatch's off-peak rate on. On other tariffs it takes the day's rate only when
  the day charged a single rate; otherwise it has no point, and the solid line carries the rate
  before it.
- **Agile** prices every half-hour differently, so the label does not fill gaps. For an Agile
  agreement, the page also fetches the tariff's published unit rates
  (`/v1/products/{product}/electricity-tariffs/{tariff}/standard-unit-rates/`, using
  `value_exc_vat` and the VAT calendar). That endpoint is public and needs no key. Those rates fill
  the zero-kWh half-hours. Where kWh is not zero, the charged rate still comes from the cost.
- **Solid lines:** a half-hour left without a rate takes the one before it (the first after it at
  the start of the day), so the line has no gaps. On IOG-SMB the House and EV each get a line:
  that side's bucket cost ÷ its kWh. Where a side drew nothing (a battery covering the house, say),
  the half-hour's **band** decides, never the half-hour before: off-peak if any bucket in it
  carries off-peak (a dispatch), else off-peak inside IOG's 23:30–05:30 window, else peak; the
  rate is that side's own rate for the band that day, or the other side's. (Carrying the rate on
  left a house at the dispatch's off-peak rate until 23:30, found on a real account 25 Nov 2026.)
- **Export rate:** payment ÷ kWh, no VAT. Octopus rounds each half-hour's amount, so when every
  payment is within half a penny of one rate × its kWh, the day is drawn at that one rate.
- Rejected: published rates for every account. They miss Intelligent's dispatch off-peak
  half-hours, which only Octopus's labels carry.

### 5.4 Rate limits

Kraken limits by query points per hour, **per account**, so each user spends their own. EMT's
experience is that the limit is shared by everything using the account. A user running EMT, or
Octopus's app, takes from the same pot.

- Requests are paced (400 ms between starts), with EMT's backoff on the rate-limit error `KT-CT-1199`.
- At most **four requests in flight**. Months come **newest first**, three at a time, each
  month's windows for import and export together. A month is shown only once it and every newer
  month are in, so a month still loading never appears as gaps.
- The query asks only `costExclTax` (VAT comes from the calendar), not `costInclTax`.
- Measured on the first real account (IOG-SMB with export, 25 Nov 2026): one request at a time,
  month windows, about 3½ minutes for 13 months (an import page took about 5 s). Now about 90 s
  and 216 requests, of which about 80 fetch and the rest recover costs; each request about 1 s.
  The 400 ms between starts is now the limit. With *Remember me*, settled months then come from
  the device (§6).
- **History depth defaults to 13 months** (enough for *vs last year*). "Load more" goes further.

## 6. Cache

Built 25 Nov 2026 (`src/cache.js`). Only when the user ticked *Remember me*, and never for the demo:
each month's answer from Octopus (import, export, Agile rates) in **IndexedDB on the user's device**,
keyed by account, meters and month, with when it was fetched.

- **A month is settled 35 days after it ends** (`SETTLE_DAYS`): Octopus's late readings, its cost
  recovery and its House/EV split revisions (EMT holds a split back up to 28 days) have had their
  time. A cached month is used only if it was **fetched** after that; anything fetched earlier is
  asked again and stored again. So the newest two months come from Octopus on every visit.
- An entry of an older stored shape (`CACHE_SHAPE`) is asked again.
- **Sign out** deletes the database, as does signing in with *Remember me* unticked and a
  remembered sign-in that has expired. A sign-in **error** keeps them: a network blip must not
  throw away what the user asked to be remembered (before 25 Nov 2026 it did, token included).
- If IndexedDB is unavailable (a private window), the page asks Octopus as without the cache.

Measured on the first real account: the first visit as before (about 90 s, 216 requests); the next
**10 s and 20 requests**, 11 months from the device and 2 from Octopus. Sign out checked the same
day: the database gone, the remembered token and billing day gone, the key field empty.

## 7. Building it

- **Plain JavaScript modules and Vite**, producing static output. No framework: two views do not
  need one, and every dependency is attack surface (§4.2).
- **Chart.js 4** for the day charts, as EMT uses. The heatmap is drawn on a plain canvas with
  EMT's colour stops, so `chartjs-chart-matrix` is not needed: one dependency fewer (§4.2).
  Both views are written fresh from `heatmap_module.html` and `billing_module.html`, without the
  EMT-only parts: corrections, settlement states, devices, carbon, PDF.
- **Hatching:** a canvas pattern (`createPattern` from a small black-and-white diagonal tile) as
  the cell's fill. EMT's heatmap already draws its "no block" cells this way.
- **The bill card's arithmetic** lives in one pure module with unit tests: periods, totals,
  standing charge, VAT, off-peak and peak. In EMT that is Python (`bill_card.py`,
  `billing_view.py`). In EMT-Lite it is JavaScript, so it has its own tests.
- **Tests:** Vitest for the arithmetic and period cutting, with recorded (fictional) Octopus
  answers as fixtures. A Playwright check (`e2e/csp.spec.js`, built 25 Nov 2026) serves the built
  page with `public/_headers` and runs the demo in Chromium. It fails on any CSP violation, any
  console error, or a request to a host other than the page and the HA badge's. It also checks that
  a request to another host is blocked.
- **CI** (`.github/workflows/`, 25 Nov 2026; CONTRIBUTING.md):
  - Unit tests with a build, and the CSP check, on every pull request. Both are required on `main`
    and `dev`.
  - CodeQL.
  - A weekly **Kraken schema check**: every GraphQL document in `src/queries.js` is validated
    against Octopus's live schema, and an issue opens for anything deprecated or removed. The same
    check runs on a pull request that changes a query.
- **Branches:** work goes to `dev` (live at `dev.emt-lite.pages.dev`); a release is `dev` → `main`.
- **Licence:** PolyForm Noncommercial, as EMT.

## 8. Rejected

- **A server or serverless proxy** (Vercel Functions, Cloudflare Workers). It would only be needed
  for CORS, which Octopus already allows (§2), and it would put every user's key through
  infrastructure we run. That is the one thing this design exists to avoid.
- **Storing keys server-side for scheduled fetches or e-mailed reports.** Same reason.
- **Asking for the account number.** `viewer.accounts` finds it.
- **`costInclTax` as the bill.** See §5.3.
- **A backend database of users' data.** IndexedDB on their device is enough.

## 9. Decisions and open questions

Decided on 25 Nov 2026:

| question | decided | where |
|---|---|---|
| Remember me | opt-in tickbox storing the refresh token, never the key; "Forget me" clears it | §4.4 |
| Export | in v1, fetched only when the account has an export meter point | §1, §5.1 |
| Quarterly billing | supported: monthly and quarterly cut by one rule | §5.2 |
| Rate line | cost ÷ kWh; zero-kWh half-hours take the day's rate for their label; Agile also fetches its public rates | §5.5 |
| Name and address | EMT-Lite on a free `*.pages.dev` address; a custom domain later if wanted | §3 |
| Heatmap colour | kWh with EMT's colour stops, hatched where missing, daily totals beside | §1 |

Still open:

1. Whether the REST `/consumption/` endpoint costs less of the rate limit than `measurements` for
   months that are only needed for the heatmap (§5.3).
2. The refresh token's lifetime (§4.4) and whether `periodStartDay` is filled in (§5.2). Both are
   checked with a real key, first thing when built.

## 10. The first pass (25 Nov 2026)

Built on `feat/scaffold`: sign-in with the key or a remembered refresh token, account and meter
discovery, the billing day (Octopus, then the latest bill, then the user), months loaded newest
first with the day and noon-to-noon cost fallbacks, Agile's published rates, the Bills view with
day charts, and the heatmap with Import / Export. Checked under the production headers with
`npm run preview`: no CSP violations, and a request to any other host is blocked.

Added beyond the design:

- **Try the demo.** A made-up account that runs through the same loader, so the page can be seen
  before a key is pasted. Its account and MPANs are the project placeholders.
- **'Future' half-hours.** A half-hour that has not happened yet is neither missing nor pending,
  and a period that has not ended is shown "so far", without comparisons.

Not yet:

- ~~Tried with a real key.~~ Done 25 Nov 2026: sign-in, Remember me, account discovery, statements,
  export detection, the House/EV split and the measurement query all work on an IOG-SMB account
  with export. Its export meter sends zero readings at night, so a night is not hatched green.
- ~~**Business VAT.**~~ Built 25 Nov 2026 (§5.3). Not yet tried on a real business account.
- ~~**Playwright CSP check** (§7).~~ Built 25 Nov 2026, run in CI on every pull request.
- ~~**Making the repository public**, which §2 requires before anyone else enters a key.~~ Done
  25 Nov 2026.
