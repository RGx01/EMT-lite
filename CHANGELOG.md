# Changelog

What changed in EMT-Lite, release by release, for the people who use it. The page at
<https://emt-lite.pages.dev/> is always the latest release: a refresh brings it. The version is in the
page's footer.

Versions are CalVer, `YYYY.M.PATCH`, as in [EMT](https://github.com/RGx01/EMT). Each release is tagged
`vYYYY.M.PATCH` and has a [GitHub release](https://github.com/RGx01/EMT-lite/releases) with its notes.
A change that moves a bill's figures says so here, so a total that differs from one you noted down
can be explained.

## [Unreleased]

## [2026.11.10] — 2026-11-28

- On an Intelligent Octopus Go smart-meter-breakdown tariff, each day's figures now show the House and
  EV kWh and cost alongside the day's total, with the standing charge and any half-hours Octopus has
  not split yet, so the parts add up to the total.
- With an export meter, each day's figures now show the day's export kWh and credit as their own
  item. The day's total is still the import's: the export is taken off on the bill card.
- Hovering over a day's chart now shows each bar's cost in pence after its kWh, VAT included, where
  Octopus has costed the half-hour. Export shows its credit.

## [2026.11.9] — 2026-11-27

- **The tab icon shows in Safari,** and on an iPhone or iPad's home screen.

## [2026.11.8] — 2026-11-27

- **A tab icon:** EMT's gauge, in pink.

## [2026.11.7] — 2026-11-27

- **EMT's logo is in the header,** in its light or dark form to match the page.
- **Click the logo to switch between light and dark,** as in EMT. The page follows your device until
  you do; the choice is then kept on this device, whether or not you ticked Remember me.

## [2026.11.6] — 2026-11-26

- **The version is in the footer,** linking to this changelog. Say which version you are on when you
  report a problem.

## [2026.11.5] — 2026-11-26

- **The bill matches an Agile statement.** Octopus's Agile statement prices each half-hour at its rate
  × its kWh rounded to 0.01 kWh, half to even. A half-hour of a few watt-hours (a home running from its
  battery has hundreds a month) costs nothing on the statement, so the card read a little above it. On
  Agile and Agile Outgoing the card now rounds the same way, as EMT does. **Agile bills may read a
  few pence to tens of pence lower than before.** The heatmap and day charts still show the meter's
  kWh, and the card says so. Other tariffs are unchanged.

## [2026.11.4] — 2026-11-26

- **A day that is not final says so.** A half-hour Octopus has the kWh for but not the cost is drawn
  hatched, with a line above the chart: its costs are still arriving, or, after a week, Octopus has not
  costed it and the bill estimates it.
- **Today and the 3 days before it are marked provisional.** Octopus's first price for a day can
  change once smart-charge dispatches and the House / EV split land, often a day or two later.
- **Coming back to the page an hour or more later fetches those days again,** so a tab left open
  catches up without a reload.

## [2026.11.3] — 2026-11-26

Found by comparing two years of one account's bills with EMT. **Bill totals move by a few pence**, and
more where Octopus never costed some half-hours.

- **The standing charge is a daily charge.** Octopus spreads it over the half-hours and rounds each
  share, so a day's shares came to a little under the rate the statement charges. A finished day now
  takes the tariff's daily rate, and a day with only some of its half-hours is scaled to the whole day.
- **Half-hours Octopus never costed are estimated** at their band's rate, and the card says how many
  kWh were estimated. They used to be left out.
- **Missing export is a warning on the card,** as missing import is: the export credit will look short.

## [2026.11.2] — 2026-11-25

- **A gas heatmap** when the account has a gas meter. The tabs are now **Electric Bills**,
  **Electric Heatmap** and **Gas Heatmap**, the last only for accounts with gas.
- **The clocks-back day:** a repeated half-hour with one of its two readings missing is counted as
  missing and hatched, instead of passing as complete.

## [2026.11.1] — 2026-11-25

- **Bills are rounded as Octopus rounds them** (EMT's Bill Rounding): every half-hour summed
  unrounded, each bill line rounded once, with the lines shown ex VAT and a VAT line. **Totals can
  move by a penny.**
- **The Intelligent rate line:** a half-hour with no import now shows off-peak inside 23:30–05:30 and
  peak outside it, instead of carrying on a dispatch's rate.
- **The bills are not authoritative:** the sign-in page and every bill say so, with a link to raise an
  issue.

## [2026.11.0] — 2026-11-25

The first public version.

- **Sign in with an Octopus API key.** The key is swapped for a token at once and never stored; the
  page talks only to Octopus. *Remember me* keeps the sign-in, and the months that have settled, on
  this device; Sign out removes both. *Try the demo* shows a made-up account.
- **Bills** by bill period, month, quarter or year, on your billing day: off-peak and peak, Octopus's
  House / EV split on Intelligent, standing charge, VAT (a business account at its tariff's rate),
  export, and comparisons with the previous period and last year. A chart and a table of half-hours
  for each day.
- **A heatmap** of net use by the half-hour, with every half-hour Octopus has no reading for hatched.
- **EMT:** the header and footer say where to get EMT for Home Assistant.

[Unreleased]: https://github.com/RGx01/EMT-lite/compare/v2026.11.10...dev
[2026.11.10]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.10
[2026.11.9]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.9
[2026.11.8]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.8
[2026.11.7]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.7
[2026.11.6]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.6
[2026.11.5]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.5
[2026.11.4]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.4
[2026.11.3]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.3
[2026.11.2]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.2
[2026.11.1]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.1
[2026.11.0]: https://github.com/RGx01/EMT-lite/releases/tag/v2026.11.0
