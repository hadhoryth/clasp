import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
export function blockedHost(host: string) {
  const h = host.toLowerCase().replace(/\.$/, '');
  return ['anthropic.com', 'claude.ai', 'claude.com'].some(
    (domain) => h === domain || h.endsWith('.' + domain),
  );
}
// Best-effort egress protection for clients honoring HTTP(S)_PROXY; not an OS firewall.
export async function startEgressGuard() {
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  };
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (blockedHost(url.hostname) || url.protocol !== 'http:' || url.username || url.password) {
      res.writeHead(403).end('Provider egress blocked by clasp.');
      return;
    }
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const outgoing = httpRequest(url, { method: req.method, headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    outgoing.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.on('aborted', () => outgoing.destroy());
    res.on('close', () => outgoing.destroy());
    req.pipe(outgoing);
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    let url: URL;
    try {
      url = new URL('http://' + req.url);
    } catch {
      client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (blockedHost(url.hostname) || url.port !== '443' || url.username || url.password) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(443, url.hostname);
    track(upstream);
    upstream.setTimeout(600000, () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
