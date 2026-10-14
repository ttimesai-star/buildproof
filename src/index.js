// Brand name availability: domains, handles, app stores, trademarks.
// Read-only by design: the checker never registers, reserves or stores names.

import { checkDomain } from './domains.js';
import { checkHandle, DEFAULT_PLATFORMS } from './handles.js';
import { checkAppStore, checkPlayStore } from './appstores.js';
import { checkTrademarks } from './trademarks.js';
import { STATUS, toHandle, toLabel } from './util.js';

export { STATUS } from './util.js';
export { renderReport, DISCLAIMER } from './report.js';

export const DEFAULT_TLDS = ['com', 'io', 'ai', 'co', 'app'];
export const DEFAULT_TM_COUNTRIES = ['US'];
export const MAX_NAMES = 10;

const AFFIXES = [
  (n) => `get${n}`,
  (n) => `${n}app`,
  (n) => `${n}hq`,
  (n) => `try${n}`,
  (n) => `${n}labs`,
  (n) => `use${n}`,
  (n) => `${n}io`,
  (n) => `join${n}`,
];

export function candidateVariations(name, limit = AFFIXES.length) {
  const base = toLabel(name).replace(/-/g, '');
  return AFFIXES.slice(0, limit).map((f) => f(base));
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

async function checkAvailabilityOnly(name, opts, deps) {
  const label = toLabel(name);
  const handle = toHandle(name);
  const domains = await mapLimit(opts.tlds, 4, (t) => checkDomain(label, t, deps));
  const handles = await mapLimit(opts.platforms, 4, (p) => checkHandle(handle, p, deps));
  return { domains, handles };
}

const allFree = (rows) => rows.every((r) => r.status === STATUS.AVAILABLE);

/**
 * @param {object} req
 * @param {string[]} req.names
 * @param {string[]} [req.tlds]
 * @param {string[]} [req.platforms]
 * @param {string[]} [req.trademarkCountries]
 * @param {boolean|number} [req.variations]  true or a count of free variations wanted
 * @param {object} deps  { fetch, whois, clock }
 */
export async function checkNames(req, deps = {}) {
  const names = [...new Set((req.names || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, MAX_NAMES);
  if (!names.length) throw new Error('at least one name is required');
  const opts = {
    tlds: (req.tlds && req.tlds.length ? req.tlds : DEFAULT_TLDS).map((t) => t.replace(/^\./, '').toLowerCase()),
    platforms: (req.platforms && req.platforms.length ? req.platforms : DEFAULT_PLATFORMS).map((p) => p.toLowerCase()),
    trademarkCountries: (req.trademarkCountries && req.trademarkCountries.length ? req.trademarkCountries : DEFAULT_TM_COUNTRIES).map((c) => c.toUpperCase()),
  };
  const wantVariations = req.variations ? (typeof req.variations === 'number' ? req.variations : 3) : 0;

  const results = [];
  for (const name of names) {
    const { domains, handles } = await checkAvailabilityOnly(name, opts, deps);
    const apps = await Promise.all([checkAppStore(name, deps), checkPlayStore(name, deps)]);
    const trademarks = await mapLimit(opts.trademarkCountries, 2, (c) => checkTrademarks(name, c, deps));
    const entry = { name, label: toLabel(name), handle: toHandle(name), domains, handles, apps, trademarks };

    if (wantVariations) {
      const free = [];
      for (const v of candidateVariations(name)) {
        if (free.length >= wantVariations) break;
        const check = await checkAvailabilityOnly(v, opts, deps);
        // Only variations that are confirmed free on every requested domain
        // and platform are offered; "couldn't confirm" disqualifies.
        if (allFree(check.domains) && allFree(check.handles)) free.push({ name: v, ...check });
      }
      entry.variations = free;
    }
    results.push(entry);
  }
  return { request: { names, ...opts, variations: wantVariations }, results };
}
