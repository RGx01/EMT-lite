#!/usr/bin/env node
// Validate EMT-Lite's GraphQL documents against Octopus's live Kraken schema (scripts/kraken-check.js).
// Introspection needs no key. Writes the findings as JSON (--out file) and exits 1 if any document
// is invalid, so a pull request that sends a field Octopus does not have fails its check.
//
//   node scripts/check-kraken.mjs [--out findings.json]

import { writeFileSync } from 'node:fs';
import { getIntrospectionQuery, buildClientSchema } from 'graphql';
import { ALL_DOCUMENTS } from '../src/queries.js';
import { checkDocuments } from './kraken-check.js';

const ENDPOINT = 'https://api.octopus.energy/v1/graphql/';
const outAt = process.argv.indexOf('--out');
const out = outAt > 0 ? process.argv[outAt + 1] : null;

const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'user-agent': 'EMT-Lite schema check' },
  body: JSON.stringify({ query: getIntrospectionQuery({ inputValueDeprecation: true }) }),
});
if (!res.ok) throw new Error(`Introspection failed: HTTP ${res.status}`);
const body = await res.json();
if (!body.data) throw new Error(`Introspection failed: ${JSON.stringify(body.errors || body).slice(0, 500)}`);

const findings = checkDocuments(buildClientSchema(body.data), ALL_DOCUMENTS);
if (out) writeFileSync(out, `${JSON.stringify(findings, null, 2)}\n`);
for (const f of findings) console.log(`${f.kind.padEnd(10)} ${f.document}: ${f.message}`);
const invalid = findings.filter((f) => f.kind === 'invalid').length;
console.log(`${Object.keys(ALL_DOCUMENTS).length} documents: ${invalid} invalid, ${findings.length - invalid} deprecated.`);
process.exit(invalid ? 1 : 0);
