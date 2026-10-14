// Apps with the same name: Apple App Store (iTunes Search API) and Google Play
// (public search page). "Same name" = the title equals the name, or the title
// starts with the name followed by a separator (":", "-", "–", "|").

import { STATUS, normalize, nowIso, safeFetch } from './util.js';

export function isSameName(title, name) {
  const t = String(title ?? '').trim();
  const n = normalize(name);
  if (!n || !normalize(t)) return false;
  if (normalize(t) === n) return true;
  const head = t.split(/\s*[:\-–—|]\s+|\s*[:|]\s*/)[0];
  return normalize(head) === n;
}

export async function checkAppStore(name, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const country = (deps.country || 'us').toLowerCase();
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(name)}&entity=software&country=${country}&limit=50`;
  const r = await safeFetch(fetchImpl, url, { headers: { Accept: 'application/json' } });
  const checkedAt = nowIso(deps.clock);
  const base = { kind: 'app', store: 'Apple App Store', target: name, source: 'iTunes Search API', checkedAt };
  if (r.status !== 200) return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: `HTTP ${r.status}` };
  let results;
  try {
    results = JSON.parse(r.text).results || [];
  } catch {
    return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: 'unparseable response' };
  }
  const matches = results
    .filter((a) => isSameName(a.trackName, name))
    .map((a) => ({ title: a.trackName, developer: a.sellerName || a.artistName, id: String(a.trackId), link: a.trackViewUrl }));
  return { ...base, status: matches.length ? STATUS.TAKEN : STATUS.AVAILABLE, matches, detail: `${results.length} results scanned` };
}

export function parsePlaySearch(html) {
  const apps = new Map();
  for (const m of html.matchAll(/href="\/store\/apps\/details\?id=([\w.]+)" aria-label="([^"]+)"/g)) {
    apps.set(m[1], decodeEntities(m[2]));
  }
  for (const m of html.matchAll(/href="\/store\/apps\/details\?id=([\w.]+)"/g)) {
    if (apps.has(m[1])) continue;
    const tail = html.slice(m.index, m.index + 4000);
    const t = tail.match(/class="DdYX5">([^<]+)</);
    if (t) apps.set(m[1], decodeEntities(t[1]));
  }
  return [...apps].map(([id, title]) => ({ id, title }));
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export async function checkPlayStore(name, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const url = `https://play.google.com/store/search?q=${encodeURIComponent(name)}&c=apps&hl=en&gl=US`;
  const r = await safeFetch(fetchImpl, url);
  const checkedAt = nowIso(deps.clock);
  const base = { kind: 'app', store: 'Google Play', target: name, source: 'Google Play search page', checkedAt };
  if (r.status !== 200) return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: `HTTP ${r.status}` };
  // Parse first: an exact match anywhere on the page wins over the
  // "No results for" banner that Play shows above unrelated suggestions.
  const apps = parsePlaySearch(r.text);
  const matches = apps
    .filter((a) => isSameName(a.title, name))
    .map((a) => ({ ...a, link: `https://play.google.com/store/apps/details?id=${a.id}` }));
  if (matches.length) return { ...base, status: STATUS.TAKEN, matches, detail: `${apps.length} results scanned` };
  if (/No results for/.test(r.text)) return { ...base, status: STATUS.AVAILABLE, matches: [], detail: 'Google Play: no results for this name' };
  if (!apps.length) return { ...base, status: STATUS.UNCONFIRMED, matches: [], detail: 'search page layout not recognised' };
  return { ...base, status: STATUS.AVAILABLE, matches: [], detail: `${apps.length} results scanned, none with this name` };
}
