import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNames, renderReport, DISCLAIMER, candidateVariations } from '../src/index.js';
import { resetBootstrapCache, IANA_BOOTSTRAP } from '../src/domains.js';
import { USPTO_ENDPOINT } from '../src/trademarks.js';
import { fakeFetch, BOOTSTRAP, fixedClock } from './helpers.js';

// "acme" is taken everywhere; every other name is free.
function world(calls) {
  return fakeFetch([
    [IANA_BOOTSTRAP, { status: 200, body: BOOTSTRAP }],
    [(u) => u.includes('rdap') && /\/domain\/acme\./.test(u), { status: 200, body: {} }],
    [(u) => u.includes('rdap'), { status: 404, body: '' }],
    [(u) => u === 'https://api.github.com/users/acme', { status: 200, body: {} }],
    [(u) => u.startsWith('https://api.github.com/users/'), { status: 404, body: {} }],
    [(u) => u === 'https://x.com/acme', { status: 200, body: '' }],
    [(u) => u.startsWith('https://x.com/'), { status: 404, body: '' }],
    [(u) => u.startsWith('https://itunes.apple.com/'), { status: 200, body: { results: [] } }],
    [(u) => u.startsWith('https://play.google.com/'), { status: 200, body: '<a href="/store/apps/details?id=a.b" aria-label="Other App" class="x"></a>' }],
    [USPTO_ENDPOINT, { status: 200, body: { hits: { totalValue: 0, hits: [] } } }],
  ], calls);
}

test('end to end: tables per name, timestamps, disclaimer, read-only requests', async () => {
  resetBootstrapCache();
  const calls = [];
  const res = await checkNames(
    { names: ['Acme', 'Zzqx'], tlds: ['com', 'ai'], platforms: ['github', 'x'] },
    { fetch: world(calls), clock: fixedClock },
  );
  assert.equal(res.results.length, 2);
  const [acme, zzqx] = res.results;
  assert.deepEqual(acme.domains.map((d) => d.status), ['taken', 'taken']);
  assert.deepEqual(zzqx.domains.map((d) => d.status), ['available', 'available']);
  assert.deepEqual(acme.handles.map((h) => h.status), ['taken', 'taken']);
  const md = renderReport(res);
  assert.ok(md.includes('## Acme') && md.includes('## Zzqx'));
  assert.ok(md.includes(DISCLAIMER));
  assert.ok(md.includes('2026-10-15T08:00:00Z'));
  // The only non-GET request is the USPTO search.
  const posts = calls.filter((c) => c.init.method && c.init.method !== 'GET');
  assert.ok(posts.length > 0 && posts.every((c) => c.url === USPTO_ENDPOINT));
});

test('variations are offered only when free on every requested domain and platform', async () => {
  resetBootstrapCache();
  const res = await checkNames({ names: ['Acme'], tlds: ['com'], platforms: ['github'], variations: 2 }, { fetch: world([]) });
  const v = res.results[0].variations;
  assert.equal(v.length, 2);
  assert.deepEqual(v.map((x) => x.name), candidateVariations('Acme').slice(0, 2));
  assert.ok(v.every((x) => x.domains.every((d) => d.status === 'available') && x.handles.every((h) => h.status === 'available')));
});

test('a platform that cannot be confirmed disqualifies every variation', async () => {
  resetBootstrapCache();
  const fetch = fakeFetch([
    [IANA_BOOTSTRAP, { status: 200, body: BOOTSTRAP }],
    [(u) => u.includes('rdap'), { status: 404, body: '' }],
    [(u) => u.includes('instagram'), { status: 429, body: '' }],
    [(u) => u.startsWith('https://itunes.apple.com/'), { status: 200, body: { results: [] } }],
    [USPTO_ENDPOINT, { status: 200, body: { hits: { hits: [] } } }],
  ]);
  const res = await checkNames({ names: ['Acme'], tlds: ['com'], platforms: ['instagram'], variations: 3 }, { fetch });
  assert.equal(res.results[0].variations.length, 0);
  assert.match(renderReport(res), /No variation could be confirmed free everywhere/);
});

test('input validation', async () => {
  await assert.rejects(() => checkNames({ names: [] }), /at least one name/);
});

test('report escapes link, image and HTML syntax from external data', () => {
  const res = {
    request: { names: ['x'], tlds: ['com'], platforms: [], trademarkCountries: ['US'] },
    results: [{
      name: '[click](https://evil.example)', domains: [], handles: [],
      apps: [{ store: 'Apple App Store', matches: [{ title: '<script>alert(1)</script>', developer: '![img](x)' }], checkedAt: 't' }],
      trademarks: [],
    }],
  };
  const md = renderReport(res);
  assert.ok(!md.includes('[click](https://evil.example)'));
  assert.ok(!md.includes('<script>'));
  assert.ok(!md.includes('![img](x)'));
});
