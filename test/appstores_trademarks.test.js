import test from 'node:test';
import assert from 'node:assert/strict';
import { isSameName, parsePlaySearch, checkAppStore, checkPlayStore } from '../src/appstores.js';
import { similarity, parseUspto, checkTrademarks, USPTO_ENDPOINT } from '../src/trademarks.js';
import { STATUS } from '../src/util.js';
import { fakeFetch } from './helpers.js';

test('same-name rule', () => {
  assert.ok(isSameName('Notion: AI Workspace', 'Notion'));
  assert.ok(isSameName('notion', 'Notion'));
  assert.ok(isSameName('Notion - Notes', 'notion'));
  assert.ok(!isSameName('Notion Calendar', 'Notion'));
  assert.ok(!isSameName('To-Do List', 'To'));
});

test('App Store exact matches only', async () => {
  const fetch = fakeFetch([['https://itunes.apple.com/search', { status: 200, body: { results: [
    { trackName: 'Acme: Tasks', sellerName: 'Acme Inc', trackId: 1, trackViewUrl: 'u1' },
    { trackName: 'Acme Calendar', sellerName: 'X', trackId: 2, trackViewUrl: 'u2' },
  ] } }]]);
  const r = await checkAppStore('Acme', { fetch });
  assert.equal(r.status, STATUS.TAKEN);
  assert.deepEqual(r.matches.map((m) => m.id), ['1']);
});

test('Google Play parser reads featured and list results', () => {
  const html = '<a href="/store/apps/details?id=notion.id" aria-label="Notion: AI Workspace" class="Q"></a>'
    + '<a class="S" href="/store/apps/details?id=com.cron.calendar"><div><span class="DdYX5">Notion Calendar</span></div></a>';
  assert.deepEqual(parsePlaySearch(html), [
    { id: 'notion.id', title: 'Notion: AI Workspace' },
    { id: 'com.cron.calendar', title: 'Notion Calendar' },
  ]);
});

test('Google Play unknown layout is unconfirmed, not "none found"', async () => {
  const fetch = fakeFetch([['https://play.google.com/', { status: 200, body: '<html>consent</html>' }]]);
  assert.equal((await checkPlayStore('Acme', { fetch })).status, STATUS.UNCONFIRMED);
});

test('Google Play "No results for" is a confirmed none, suggestions ignored', async () => {
  const html = 'No results for Zzq Here are some apps you might like <a href="/store/apps/details?id=z.q" aria-label="Zzq" class="x"></a>';
  const fetch = fakeFetch([['https://play.google.com/', { status: 200, body: html }]]);
  const r = await checkPlayStore('Zzq', { fetch });
  assert.equal(r.status, STATUS.AVAILABLE);
  assert.equal(r.matches.length, 0);
});

test('trademark similarity', () => {
  assert.equal(similarity('NOTION', 'Notion'), 'identical');
  assert.equal(similarity('NOTIONN', 'Notion'), 'very similar');
  assert.equal(similarity('NOTION LABS', 'Notion'), 'contains the name');
  assert.equal(similarity('MOTION', 'Notion'), 'very similar');
  assert.equal(similarity('BANANA', 'Notion'), null);
  assert.equal(similarity('ACE', 'Acme'), null);
  assert.equal(similarity('PURVELA', 'Quorvela'), null);
  assert.equal(similarity('QUORVELLA', 'Quorvela'), 'very similar');
});

test('USPTO parse: live first, serial, registration number and status kept', () => {
  const json = { hits: { totalValue: 3, hits: [
    { id: '1', source: { id: '74490398', wordmark: 'NOTION', registrationId: '1884722', alive: false, ownerName: ['Old Co'], internationalClass: ['IC 009'] } },
    { id: '2', source: { id: '88000001', wordmark: 'NOTION', registrationId: '6000001', alive: true, statusDescription: 'REGISTERED', ownerName: ['Notion Labs, Inc.'], internationalClass: ['IC 009', 'IC 042'] } },
    { id: '3', source: { id: '99', wordmark: 'BANANA', alive: true } },
  ] } };
  const rows = parseUspto(json, 'Notion');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, 'LIVE');
  assert.equal(rows[0].serialNumber, '88000001');
  assert.equal(rows[0].registrationNumber, '6000001');
  assert.match(rows[0].link, /tsdr\.uspto\.gov/);
});

test('trademark check: US posts a query, other countries are named and marked unconfirmed', async () => {
  const calls = [];
  const fetch = fakeFetch([[USPTO_ENDPOINT, { status: 200, body: { hits: { totalValue: 0, hits: [] } } }]], calls);
  const us = await checkTrademarks('Zzq', 'US', { fetch });
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(us.database, 'USPTO Trademark Search (tmsearch.uspto.gov)');
  assert.equal(us.status, 'no live identical or very similar mark found');
  const eu = await checkTrademarks('Zzq', 'EU', { fetch });
  assert.equal(eu.status, STATUS.UNCONFIRMED);
  assert.match(eu.database, /EUIPO/);
});

test('USPTO bot challenge page is unconfirmed', async () => {
  const fetch = fakeFetch([[USPTO_ENDPOINT, { status: 200, body: '<html>challenge</html>' }]]);
  assert.equal((await checkTrademarks('Acme', 'US', { fetch })).status, STATUS.UNCONFIRMED);
});
