// Markdown report: one section per name, every row with its check time.

export const DISCLAIMER =
  'Trademark results are a starting point, not legal advice. Whether a mark is "too similar" is a legal judgment; ' +
  'ask a trademark attorney before relying on a name. Availability can change at any moment and is accurate only at the time shown.';

// Text from registries, stores and trademark owners goes into the report, so
// characters that could form links, images, HTML or table cells are escaped.
// Dots, hyphens and parentheses stay as they are (domains and owner names).
export const esc = (s) =>
  String(s ?? '')
    .replace(/[\\`*_[\]<>|!#]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');

function domainTable(rows) {
  const lines = ['| Domain | Result | Source | Checked (UTC) |', '|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${esc(r.target)} | ${esc(r.status)} | ${esc(r.source)} | ${esc(r.checkedAt)} |`);
  return lines.join('\n');
}

function handleTable(rows) {
  const lines = ['| Platform | Handle | Result | Note | Checked (UTC) |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${esc(r.label || r.platform)} | ${esc(r.target)} | ${esc(r.status)} | ${esc(r.detail)} | ${esc(r.checkedAt)} |`);
  return lines.join('\n');
}

function appTable(rows) {
  const lines = ['| Store | Apps with the same name | Checked (UTC) |', '|---|---|---|'];
  for (const r of rows) {
    const m = r.matches && r.matches.length
      ? r.matches.slice(0, 5).map((a) => `${esc(a.title)}${a.developer ? ` (${esc(a.developer)})` : ''}`).join('; ')
      : r.status === "couldn't confirm" ? `couldn't confirm (${esc(r.detail)})` : 'none found';
    lines.push(`| ${esc(r.store)} | ${m} | ${esc(r.checkedAt)} |`);
  }
  return lines.join('\n');
}

function trademarkBlock(rows) {
  const out = [];
  for (const t of rows) {
    out.push(`**${esc(t.country)} — ${esc(t.database)}** (checked ${esc(t.checkedAt)}): ${esc(t.status)}${t.detail ? `; ${esc(t.detail)}` : ''}`);
    if (t.matches && t.matches.length) {
      out.push('', '| Mark | Similarity | Serial no. | Reg. no. | Status | Owner | Classes |', '|---|---|---|---|---|---|---|');
      for (const m of t.matches.slice(0, 15)) {
        out.push(`| ${esc(m.mark)} | ${esc(m.similarity)} | [${esc(m.serialNumber)}](${m.link}) | ${esc(m.registrationNumber || '—')} | ${esc(m.status)}${m.statusDetail ? ` (${esc(m.statusDetail)})` : ''} | ${esc(m.owner || '—')} | ${esc((m.classes || []).join(', '))} |`);
      }
    }
    out.push('');
  }
  return out.join('\n');
}

export function renderReport(result) {
  const parts = ['# Brand name availability report', ''];
  const rq = result.request;
  parts.push(`Checked: names ${rq.names.join(', ')}; domains .${rq.tlds.join(', .')}; platforms ${rq.platforms.join(', ')}; trademark registers ${rq.trademarkCountries.join(', ')}.`, '');
  for (const r of result.results) {
    parts.push(`## ${esc(r.name)}`, '', '### Domains', domainTable(r.domains), '', '### Social handles', handleTable(r.handles), '', '### App stores', appTable(r.apps), '', '### Trademarks', trademarkBlock(r.trademarks));
    if (r.variations) {
      parts.push('### Suggested variations (free on every requested domain and platform)');
      if (!r.variations.length) parts.push("No variation could be confirmed free everywhere. Platforms marked \"couldn't confirm\" disqualify a variation.");
      for (const v of r.variations) parts.push(`- **${esc(v.name)}** — domains: ${v.domains.map((d) => d.target).join(', ')}; checked ${esc(v.domains[0]?.checkedAt)}`);
      parts.push('');
    }
  }
  parts.push('---', DISCLAIMER, '', 'Nothing searched here was registered, reserved or stored by this agent.');
  return parts.join('\n');
}
