// WHOIS (RFC 3912) transport for Node. Not imported by the core modules, so
// Cloudflare Workers never load it; there, build the same (server, query)
// function on `connect()` from 'cloudflare:sockets'.
import net from 'node:net';

export function whoisNode(server, query, timeoutMs = 10000, port = 43) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const sock = net.createConnection({ host: server, port });
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.on('error', () => {}); // swallow late errors from a destroyed socket
      sock.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`WHOIS timeout after ${timeoutMs} ms`)), timeoutMs);
    sock.on('connect', () => sock.write(`${query}\r\n`));
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (err) => finish(reject, err));
    sock.on('close', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
  });
}
