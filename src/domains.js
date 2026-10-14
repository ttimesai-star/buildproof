// Domain availability from the registry itself: RDAP via the IANA bootstrap
// file, WHOIS (port 43) for ccTLDs that publish no RDAP service.
// Read-only: nothing is registered, reserved or sent to a registrar.

import { STATUS, nowIso, safeFetch } from './util.js';

export const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

// WHOIS servers for common TLDs that are missing from the RDAP bootstrap.
export const WHOIS_SERVERS = {
  io: 'whois.nic.io',
  co: 'whois.registry.co',
  de: 'whois.denic.de',
  by: 'whois.cctld.by',
  me: 'whois.nic.me',
  uk: 'whois.nic.uk',
  eu: 'whois.eu',
  fr: 'whois.nic.fr',
  ru: 'whois.tcinet.ru',
  tv: 'whois.nic.tv',
  sh: 'whois.nic.sh',
  gg: 'whois.gg',
  so: 'whois.nic.so',
};

// Phrases registries use for "no such domain". Checked before the taken patterns.
const WHOIS_FREE = [
  /^\s*no match\b/im,
  /\bnot found\b/i,
  /\bno data found\b/i,
  /\bno entries found\b/i,
  /^\s*status:\s*free\b/im,
  /\bdomain .* is available\b/i,
  /\bno object found\b/i,
];
const WHOIS_TAKEN = [/^\s*domain name:\s*\S+/im, /^\s*registrar:/im, /^\s*status:\s*connect\b/im, /^\s*domain:\s*\S+/im];

let bootstrapCache = null;

export async function loadBootstrap(fetchImpl) {
  if (bootstrapCache) return bootstrapCache;
  const r = await safeFetch(fetchImpl, IANA_BOOTSTRAP, { headers: { Accept: 'application/json' } });
  if (r.status !== 200) throw new Error(`IANA RDAP bootstrap unavailable (HTTP ${r.status})`);
  const data = JSON.parse(r.text);
  const map = {};
  for (const [tlds, urls] of data.services) {
    const base = urls.find((u) => u.startsWith('https://')) || urls[0];
    for (const tld of tlds) map[tld.toLowerCase()] = base.endsWith('/') ? base : `${base}/`;
  }
  bootstrapCache = map;
  return map;
}

export function resetBootstrapCache() {
  bootstrapCache = null;
}

export function classifyWhois(text) {
  if (WHOIS_FREE.some((re) => re.test(text))) return STATUS.AVAILABLE;
  if (WHOIS_TAKEN.some((re) => re.test(text))) return STATUS.TAKEN;
  return STATUS.UNCONFIRMED;
}

/**
 * @param {string} label  domain label, e.g. "acme"
 * @param {string} tld    extension without dot, e.g. "com"
 * @param {{fetch?: Function, whois?: (server: string, query: string) => Promise<string>, clock?: Function}} deps
 */
export async function checkDomain(label, tld, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const domain = `${label}.${tld}`.toLowerCase();
  const base = { kind: 'domain', target: domain };

  let bootstrap;
  try {
    bootstrap = await loadBootstrap(fetchImpl);
  } catch (err) {
    return { ...base, status: STATUS.UNCONFIRMED, source: IANA_BOOTSTRAP, detail: err.message, checkedAt: nowIso(deps.clock) };
  }

  const rdapBase = bootstrap[tld.toLowerCase()];
  if (rdapBase) {
    const url = `${rdapBase}domain/${domain}`;
    const r = await safeFetch(fetchImpl, url, { headers: { Accept: 'application/rdap+json' } });
    const checkedAt = nowIso(deps.clock);
    if (r.status === 404) return { ...base, status: STATUS.AVAILABLE, source: `RDAP ${new URL(url).host}`, detail: 'no registration record', checkedAt };
    if (r.status === 200) return { ...base, status: STATUS.TAKEN, source: `RDAP ${new URL(url).host}`, detail: 'registration record exists', checkedAt };
    return { ...base, status: STATUS.UNCONFIRMED, source: `RDAP ${new URL(url).host}`, detail: `registry answered HTTP ${r.status}`, checkedAt };
  }

  const server = WHOIS_SERVERS[tld.toLowerCase()];
  if (!server || !deps.whois) {
    return {
      ...base,
      status: STATUS.UNCONFIRMED,
      source: server ? `WHOIS ${server}` : 'none',
      detail: server ? 'WHOIS transport not available in this runtime' : 'registry publishes no RDAP service and no WHOIS server is configured',
      checkedAt: nowIso(deps.clock),
    };
  }
  try {
    const text = await deps.whois(server, domain);
    return { ...base, status: classifyWhois(text), source: `WHOIS ${server}`, detail: 'registry WHOIS', checkedAt: nowIso(deps.clock) };
  } catch (err) {
    return { ...base, status: STATUS.UNCONFIRMED, source: `WHOIS ${server}`, detail: `WHOIS error: ${err.message}`, checkedAt: nowIso(deps.clock) };
  }
}
