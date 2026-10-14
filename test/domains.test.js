import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDomain, classifyWhois, resetBootstrapCache, IANA_BOOTSTRAP } from '../src/domains.js';
import { STATUS } from '../src/util.js';
import { fakeFetch, BOOTSTRAP, fixedClock } from './helpers.js';

const routes = [
  [IANA_BOOTSTRAP, { status: 200, body: BOOTSTRAP }],
  ['https://rdap.verisign.com/com/v1/domain/taken.com', { status: 200, body: { ldhName: 'TAKEN.COM' } }],
  ['https://rdap.verisign.com/com/v1/domain/free.com', { status: 404, body: '' }],
  ['https://rdap.identitydigital.services/rdap/domain/busy.ai', { status: 429, body: '' }],
];

test('RDAP 200 is taken, 404 is available, other codes are unconfirmed', async () => {
  resetBootstrapCache();
  const fetch = fakeFetch(routes);
  const t = await checkDomain('taken', 'com', { fetch, clock: fixedClock });
  const f = await checkDomain('free', 'com', { fetch, clock: fixedClock });
  const u = await checkDomain('busy', 'ai', { fetch, clock: fixedClock });
  assert.equal(t.status, STATUS.TAKEN);
  assert.equal(f.status, STATUS.AVAILABLE);
  assert.equal(u.status, STATUS.UNCONFIRMED);
  assert.equal(t.checkedAt, '2026-10-15T08:00:00Z');
  assert.match(t.source, /rdap\.verisign\.com/);
});

test('TLD without RDAP falls back to WHOIS; no transport means unconfirmed', async () => {
  resetBootstrapCache();
  const fetch = fakeFetch(routes);
  const noTransport = await checkDomain('acme', 'io', { fetch });
  assert.equal(noTransport.status, STATUS.UNCONFIRMED);
  const asked = [];
  const whois = async (server, q) => {
    asked.push([server, q]);
    return 'NOT FOUND\n>>> Last update of WHOIS database';
  };
  const free = await checkDomain('acme', 'io', { fetch, whois });
  assert.equal(free.status, STATUS.AVAILABLE);
  assert.deepEqual(asked, [['whois.nic.io', 'acme.io']]);
});

test('WHOIS classification', () => {
  assert.equal(classifyWhois('Domain Name: google.io\nRegistrar: MarkMonitor'), STATUS.TAKEN);
  assert.equal(classifyWhois('Domain: example.de\nStatus: connect'), STATUS.TAKEN);
  assert.equal(classifyWhois('Domain: zzq.de\nStatus: free'), STATUS.AVAILABLE);
  assert.equal(classifyWhois('No match for "ZZQ.CO".'), STATUS.AVAILABLE);
  assert.equal(classifyWhois('Rate limit exceeded'), STATUS.UNCONFIRMED);
});

test('bootstrap failure is reported, not thrown', async () => {
  resetBootstrapCache();
  const r = await checkDomain('acme', 'com', { fetch: fakeFetch([]) });
  assert.equal(r.status, STATUS.UNCONFIRMED);
  assert.match(r.detail, /bootstrap/);
});

test('bootstrap: concurrent callers share one request; a failure is retried next time', async () => {
  resetBootstrapCache();
  let n = 0;
  let fail = true;
  const fetch = async (url) => {
    if (url === IANA_BOOTSTRAP) {
      n++;
      if (fail) return { status: 503, url, text: async () => '' };
      return { status: 200, url, text: async () => JSON.stringify(BOOTSTRAP) };
    }
    return { status: 404, url, text: async () => '' };
  };
  const first = await checkDomain('acme', 'com', { fetch });
  assert.equal(first.status, STATUS.UNCONFIRMED);
  fail = false;
  const all = await Promise.all(['a', 'b', 'c'].map((l) => checkDomain(l, 'com', { fetch })));
  assert.deepEqual(all.map((r) => r.status), [STATUS.AVAILABLE, STATUS.AVAILABLE, STATUS.AVAILABLE]);
  assert.equal(n, 2);
});

test('a registered record that happens to contain "not found" stays taken', () => {
  const rec = ['Domain Name: acme.io', 'Registrar: Example Registrar', 'Registrant Phone: not found'].join('\n');
  assert.equal(classifyWhois(rec), STATUS.TAKEN);
});
