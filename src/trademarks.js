// Trademark search. US: USPTO Trademark Search (the public tmsearch.uspto.gov
// index) with serial number, registration number and live/dead status.
// Other jurisdictions have no keyless public API; the report names the
// database to check and marks the result "couldn't confirm" instead of
// pretending it was searched.

import { STATUS, levenshtein, normalize, nowIso, safeFetch } from './util.js';

export const USPTO_ENDPOINT = 'https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch';

export const MANUAL_DATABASES = {
  EU: { name: 'EUIPO eSearch plus', url: (n) => `https://euipo.europa.eu/eSearch/#basic/1+1+1+1/100+100+100+100/${encodeURIComponent(n)}` },
  UK: { name: 'UK IPO trade mark search', url: () => 'https://trademarks.ipo.gov.uk/ipo-tmtext' },
  WIPO: { name: 'WIPO Global Brand Database', url: (n) => `https://branddb.wipo.int/en/similarname/results?sort=score%20desc&strategy=concept&brandName=${encodeURIComponent(n)}` },
};

// Identical after normalisation, or within a small edit distance, or one
// contains the other (e.g. "ACME" vs "ACME LABS").
export function similarity(mark, name) {
  const a = normalize(mark);
  const b = normalize(name);
  if (!a || !b) return null;
  if (a === b) return 'identical';
  const limit = b.length <= 3 ? 0 : b.length <= 8 ? 1 : 2;
  if (levenshtein(a, b) <= limit) return 'very similar';
  if (b.length >= 4 && (a.startsWith(b) || a.endsWith(b))) return 'contains the name';
  if (a.length >= 4 && (b.startsWith(a) || b.endsWith(a))) return 'contained in the name';
  return null;
}

export function usptoQuery(name, size = 50) {
  return {
    query: {
      bool: {
        should: [
          { match_phrase: { WM: { query: name, boost: 5 } } },
          { match: { WM: { query: name, fuzziness: 'AUTO' } } },
        ],
        minimum_should_match: 1,
      },
    },
    size,
  };
}

export function parseUspto(json, name) {
  const hits = json?.hits?.hits || [];
  const rows = [];
  for (const h of hits) {
    const s = h.source || h._source || {};
    const mark = s.wordmark || s.wordmarkPseudoText;
    if (!mark) continue;
    const sim = similarity(mark, name);
    if (!sim) continue;
    rows.push({
      mark,
      similarity: sim,
      serialNumber: String(s.id || h.id || ''),
      registrationNumber: s.registrationId || null,
      status: s.alive ? 'LIVE' : 'DEAD',
      statusDetail: s.statusDescription || null,
      owner: Array.isArray(s.ownerName) ? s.ownerName[0] : s.ownerName || null,
      classes: s.internationalClass || [],
      link: `https://tsdr.uspto.gov/#caseNumber=${s.id || h.id}&caseType=SERIAL_NO&searchType=statusSearch`,
    });
  }
  const rank = { identical: 0, 'very similar': 1, 'contains the name': 2, 'contained in the name': 3 };
  rows.sort((x, y) => (x.status === y.status ? 0 : x.status === 'LIVE' ? -1 : 1) || rank[x.similarity] - rank[y.similarity]);
  return rows;
}

export async function checkTrademarks(name, country = 'US', deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const c = country.toUpperCase();
  if (c !== 'US') {
    const db = MANUAL_DATABASES[c] || MANUAL_DATABASES.WIPO;
    return {
      kind: 'trademark', country: c, target: name, database: db.name, status: STATUS.UNCONFIRMED, matches: [],
      detail: `not searched automatically; check ${db.name}: ${db.url(name)}`, checkedAt: nowIso(deps.clock),
    };
  }
  const r = await safeFetch(fetchImpl, USPTO_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: 'https://tmsearch.uspto.gov' },
    body: JSON.stringify(usptoQuery(name)),
  });
  const base = { kind: 'trademark', country: 'US', target: name, database: 'USPTO Trademark Search (tmsearch.uspto.gov)', checkedAt: nowIso(deps.clock) };
  if (r.status !== 200) return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: `USPTO answered HTTP ${r.status}` };
  let json;
  try {
    json = JSON.parse(r.text);
  } catch {
    return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: 'USPTO returned a non-JSON page (likely a bot challenge)' };
  }
  const matches = parseUspto(json, name);
  const live = matches.filter((m) => m.status === 'LIVE');
  return {
    ...base,
    status: live.length ? 'possible conflict' : 'no live identical or very similar mark found',
    matches,
    detail: `top ${json?.hits?.hits?.length ?? 0} of ${json?.hits?.totalValue ?? 0} index hits screened`,
  };
}
