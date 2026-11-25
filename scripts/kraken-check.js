// The Kraken schema check (CONTRIBUTING.md): every GraphQL document the page sends (src/queries.js)
// validated against Octopus's live schema. Two kinds of finding:
//   invalid     the document no longer validates: a field, argument, type or enum value is gone
//               or changed. The page is broken (or will be on deploy).
//   deprecated  it validates, but uses something Octopus has marked deprecated: migrate before
//               the removal date in the reason.

import { parse, validate, specifiedRules, NoDeprecatedCustomRule } from 'graphql';

/** Findings for `documents` ({ name: source }) against `schema`, sorted, de-duplicated. */
export function checkDocuments(schema, documents) {
  const out = [];
  for (const [name, source] of Object.entries(documents)) {
    let doc;
    try {
      doc = parse(source);
    } catch (e) {
      out.push({ document: name, kind: 'invalid', message: `does not parse: ${e.message}` });
      continue;
    }
    for (const e of validate(schema, doc, specifiedRules)) out.push({ document: name, kind: 'invalid', message: e.message });
    for (const e of validate(schema, doc, [NoDeprecatedCustomRule])) out.push({ document: name, kind: 'deprecated', message: e.message });
  }
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.kind}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message));
}
