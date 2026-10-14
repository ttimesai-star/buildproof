import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { whoisNode } from '../src/whois-node.js';

function server(handler) {
  return new Promise((resolve) => {
    const srv = net.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

test('whoisNode sends the query and returns the full answer', async () => {
  let got = '';
  const srv = await server((s) => s.on('data', (d) => { got += d; s.end('Domain Name: acme.io\r\nRegistrar: X\r\n'); }));
  const text = await whoisNode('127.0.0.1', 'acme.io', 2000, srv.address().port);
  srv.close();
  assert.equal(got, 'acme.io\r\n');
  assert.match(text, /Registrar: X/);
});

test('whoisNode times out once and settles once', async () => {
  const srv = await server(() => {}); // never answers
  await assert.rejects(() => whoisNode('127.0.0.1', 'acme.io', 150, srv.address().port), /timeout/);
  srv.close();
});
