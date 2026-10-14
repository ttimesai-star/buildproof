import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHandle } from '../src/handles.js';
import { STATUS } from '../src/util.js';
import { fakeFetch } from './helpers.js';

test('GitHub 200/404', async () => {
  const fetch = fakeFetch([
    ['https://api.github.com/users/acme', { status: 200, body: { login: 'acme' } }],
    ['https://api.github.com/users/zzq', { status: 404, body: {} }],
  ]);
  assert.equal((await checkHandle('acme', 'github', { fetch })).status, STATUS.TAKEN);
  assert.equal((await checkHandle('zzq', 'github', { fetch })).status, STATUS.AVAILABLE);
});

test('Instagram: profile is taken, rate limit is unconfirmed, never guessed', async () => {
  const fetch = fakeFetch([
    ['https://www.instagram.com/api/v1/users/web_profile_info/?username=acme', { status: 200, body: { data: { user: { username: 'acme' } } } }],
    ['https://www.instagram.com/api/v1/users/web_profile_info/?username=zzq', { status: 429, body: '' }],
  ]);
  assert.equal((await checkHandle('acme', 'instagram', { fetch })).status, STATUS.TAKEN);
  const r = await checkHandle('zzq', 'instagram', { fetch });
  assert.equal(r.status, STATUS.UNCONFIRMED);
  assert.match(r.detail, /429/);
});

test('TikTok: uniqueId means taken, 10221 means not found, anything else unconfirmed', async () => {
  const fetch = fakeFetch([
    ['https://www.tiktok.com/@acme', { status: 200, body: '..."uniqueId":"acme"...' }],
    ['https://www.tiktok.com/@zzq', { status: 200, body: '..."statusCode":10221,...' }],
    ['https://www.tiktok.com/@wall', { status: 200, body: '<html>login</html>' }],
  ]);
  assert.equal((await checkHandle('acme', 'tiktok', { fetch })).status, STATUS.TAKEN);
  assert.equal((await checkHandle('zzq', 'tiktok', { fetch })).status, STATUS.AVAILABLE);
  assert.equal((await checkHandle('wall', 'tiktok', { fetch })).status, STATUS.UNCONFIRMED);
});

test('Reddit username_available true/false and block', async () => {
  const fetch = fakeFetch([
    [(u) => u.endsWith('user=free'), { status: 200, body: 'true' }],
    [(u) => u.endsWith('user=acme'), { status: 200, body: 'false' }],
    [(u) => u.endsWith('user=blocked'), { status: 403, body: '<html>' }],
  ]);
  assert.equal((await checkHandle('free', 'reddit', { fetch })).status, STATUS.AVAILABLE);
  assert.equal((await checkHandle('acme', 'reddit', { fetch })).status, STATUS.TAKEN);
  assert.equal((await checkHandle('blocked', 'reddit', { fetch })).status, STATUS.UNCONFIRMED);
});

test('Telegram never reports available', async () => {
  const fetch = fakeFetch([['https://t.me/', { status: 200, body: '<html>no title</html>' }]]);
  assert.equal((await checkHandle('zzq', 'telegram', { fetch })).status, STATUS.UNCONFIRMED);
});

test('network error and unknown platform are unconfirmed', async () => {
  const fetch = async () => {
    throw new Error('ECONNRESET');
  };
  assert.equal((await checkHandle('acme', 'x', { fetch })).status, STATUS.UNCONFIRMED);
  assert.equal((await checkHandle('acme', 'myspace', { fetch })).status, STATUS.UNCONFIRMED);
});
