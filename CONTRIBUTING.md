# Contributing to EMT-Lite

EMT-Lite is a static page: an Octopus customer pastes an API key and sees their bills and the
half-hours Octopus has no reading for. Everything runs in the browser, and the page talks only to
`api.octopus.energy`. Changes must keep it that way. [docs/design.md](docs/design.md) is the
living design: read the section a change touches, and update it in the same pull request.

## Reporting a problem

Use [Issues](https://github.com/RGx01/EMT-lite/issues/new/choose). **Never post your API key**,
account number, MPAN, address or bill figures: this repository is public. A screenshot is fine
once those are blurred. A security problem goes to a private report instead (see [SECURITY.md](SECURITY.md)).

## Branches

- `main` is what is live at <https://emt-lite.pages.dev/>.
- `dev` is where changes gather, and is live at <https://dev.emt-lite.pages.dev/>.
- Work on `feat/…`, `fix/…`, `chore/…` or `docs/…`, branched from `dev`, and open the pull request
  to `dev`.
- A release is a pull request from `dev` to `main`.
- Nothing is pushed straight to `main` or `dev`: rulesets require a pull request whose checks
  pass. Commits on `main` must be signed. A merge made on GitHub is signed by GitHub.

## Checks

Every pull request runs:

| check | what it proves | locally |
|---|---|---|
| Unit tests and build | Vitest (`tests/`) and `vite build` | `npm test`, `npm run build` |
| CSP check | the built page, served with `public/_headers`, runs the demo in Chromium with no CSP violation, no console error, and no request to a host it should not reach | `npx playwright install chromium` once, then `npm run test:e2e` |
| CodeQL | code scanning of the JavaScript and the workflows | — |
| Kraken schema | only when a query changes: every GraphQL document validates against Octopus's live schema | `npm run check:kraken` |

The Kraken schema check also runs **weekly**. It opens (or updates) one `kraken-schema` issue if
Octopus deprecates or removes anything the page sends. Every GraphQL document lives in
`src/queries.js`, so the check sees exactly what the page sends: add new queries there, not inline.

A regression test must fail on the code before the fix. Check that it does.

## What a change must carry

- **Security first.** No new host in the CSP's `connect-src`, no third-party code at runtime, no
  analytics. The key is swapped for a token at once and never stored. A change to
  `public/_headers` gets its own reason in the pull request and in design §4.
- **No real customer figures or identifiers** in code, tests, docs, commits or issues. Use the
  placeholders: account `A-0000ABC7`, MPANs `2600000000001` / `2600000000002`, postcode `SW1A`.
- **Octopus's API sparingly.** Small requests, a few at a time (design §5.4); a month that has
  settled is read from the device cache, not asked again.
- **Dependencies pinned exactly** (`package.json` has no `^`). Dependabot raises bumps to `dev`.

## Deploying

Cloudflare Pages, uploaded with Wrangler (`npx wrangler login` once). Deploying needs access to
the Cloudflare project, so the maintainer does it:

```bash
npm run deploy:dev   # from a clean dev, level with GitHub → dev.emt-lite.pages.dev
npm run deploy       # from a clean main, level with GitHub → emt-lite.pages.dev
```

Both refuse a dirty tree, the wrong branch, or a branch behind GitHub, then test, build and upload
`dist/` tagged with the commit.

## Licence

[PolyForm Noncommercial](LICENSE). By contributing you agree that your contribution is
licensed the same way.
