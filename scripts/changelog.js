// CHANGELOG.md's sections (CONTRIBUTING.md "Releasing"). Used by scripts/release.sh, which takes a
// release's notes from it, and by the tests, which hold the changelog to the version in package.json.
//   node scripts/changelog.js notes 2026.11.6    print that version's notes
//   node scripts/changelog.js check 2026.11.6    exit 1 unless that version has a dated section
//   node scripts/changelog.js release 2026.11.6 2026.11.5   the same, for a release PR over main's version
//   node scripts/changelog.js prepare 2026.11.6 [DATE]      move [Unreleased] under that version, dated

const HEAD = /^## \[([^\]]+)\](?: — (\d{4}-\d{2}-\d{2}))?\s*$/;

/** The sections, in order: { version, date (or null), body (the lines under the heading, trimmed) }. */
export function sections(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    const m = HEAD.exec(line);
    if (m) { cur = { version: m[1], date: m[2] || null, lines: [] }; out.push(cur); continue; }
    if (/^\[[^\]]+\]: /.test(line)) { cur = null; continue; }      // the link list at the end
    if (cur) cur.lines.push(line);
  }
  return out.map(({ version, date, lines }) => ({ version, date, body: lines.join('\n').trim() }));
}

/** A section's notes for a GitHub release, which shows a single line break as a break: each
 *  wrapped paragraph or bullet joined back into one line. */
export function unwrap(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const cont = /^ {2,}\S/.test(line) && out.length && out[out.length - 1].trim() !== '';
    const para = /^\S/.test(line) && !/^[-*] /.test(line) && out.length && out[out.length - 1].trim() !== ''
      && !/^[-*] /.test(out[out.length - 1]);
    if (cont || para) out[out.length - 1] += ` ${line.trim()}`;
    else out.push(line);
  }
  return out.join('\n');
}

/** What is wrong with the changelog for releasing `version`, or [] when nothing is. */
export function problems(text, version) {
  const all = sections(text);
  const out = [];
  if (all[0]?.version !== 'Unreleased') out.push('the first section should be [Unreleased]');
  const s = all.find((x) => x.version === version);
  if (!s) out.push(`no section for ${version}`);
  else {
    if (!s.date) out.push(`${version} has no date ("## [${version}] — YYYY-MM-DD")`);
    if (!s.body) out.push(`${version} has no notes`);
    if (all.indexOf(s) !== 1) out.push(`${version} should come straight after [Unreleased]`);
  }
  if (!new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: `, 'm').test(text)) out.push(`no link for [${version}] at the end`);
  return out;
}

const num = (v) => String(v).split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);

/** What is wrong with a release pull request: `version` (package.json on the PR) over `base` (on
 *  main). The version is bumped, its section dated and filled, and [Unreleased] emptied into it. */
export function releaseProblems(text, version, base) {
  const out = problems(text, version);
  if (!(num(version) > num(base))) out.push(`the version ${version} is not after main's ${base}: bump it in package.json`);
  const un = sections(text)[0];
  if (un?.version === 'Unreleased' && un.body) out.push('[Unreleased] still has notes: move them under the new version');
  return out;
}

/** CHANGELOG.md with [Unreleased]'s notes moved under `## [version] — date`, an empty [Unreleased]
 *  above it, and the links at the end updated. */
export function prepare(text, version, date) {
  const un = sections(text)[0];
  if (un?.version !== 'Unreleased' || !un.body) throw new Error('[Unreleased] has no notes to release');
  if (sections(text).some((x) => x.version === version)) throw new Error(`${version} is already in CHANGELOG.md`);
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^## \[Unreleased\]\s*$/.test(l));
  lines.splice(at + 1, 0, '', `## [${version}] — ${date}`);
  let out = lines.join('\n');
  out = out.replace(/^\[Unreleased\]: (.*\/compare\/)v[^.]+\.[^.]+\.[^.]+(\.\.\.dev)$/m, `[Unreleased]: $1v${version}$2`);
  out = out.replace(/^(\[[^\]]+\]: .*)$/m, (first) => (first.startsWith('[Unreleased]')
    ? `${first}\n[${version}]: https://github.com/RGx01/EMT-lite/releases/tag/v${version}` : first));
  return out;
}

// run as a script (not imported by the tests)
if (process.argv[1] && import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href) {
  const [, , cmd, version] = process.argv;
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  if (cmd === 'notes') {
    const s = sections(text).find((x) => x.version === version);
    if (!s?.body) { console.error(`No notes for ${version} in CHANGELOG.md.`); process.exit(1); }
    console.log(unwrap(s.body));
  } else if (cmd === 'prepare') {
    const { writeFileSync } = await import('node:fs');
    const date = process.argv[4] || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    writeFileSync(new URL('../CHANGELOG.md', import.meta.url), prepare(text, version, date));
    console.log(`CHANGELOG.md: [Unreleased] is now ${version} — ${date}.`);
  } else if (cmd === 'check' || cmd === 'release') {
    const p = cmd === 'check' ? problems(text, version) : releaseProblems(text, version, process.argv[4]);
    for (const x of p) console.error(`CHANGELOG.md: ${x}`);
    process.exit(p.length ? 1 : 0);
  } else {
    console.error('usage: node scripts/changelog.js notes|check|prepare VERSION, or release VERSION MAIN_VERSION'); process.exit(2);
  }
}
