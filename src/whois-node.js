// WHOIS (RFC 3912) transport for Node. Cloudflare Workers can use
// `connect()` from 'cloudflare:sockets' with the same signature.
import net from 'node:net';

export function whoisNode(server, query, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const sock = net.createConnection({ host: server, port: 43 });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`WHOIS timeout after ${timeoutMs} ms`));
    }, timeoutMs);
    sock.on('connect', () => sock.write(`${query}\r\n`));
    sock.on('data', (c) => chunks.push(c));
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
