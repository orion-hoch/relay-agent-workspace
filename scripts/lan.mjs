import { createServer } from 'node:https';
import { request as httpRequest } from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const directory = resolve(process.env.SHOAL_DATA_DIR || '.shoal', 'tls');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const localAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item?.family === 'IPv4' && !item.internal)
  .map((item) => item.address);
const extra = (process.env.SHOAL_LAN_HOSTS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const names = [
  ...new Set([
    'localhost',
    hostname(),
    ...extra.filter((value) => !/^\d+\.\d+\.\d+\.\d+$/.test(value)),
  ]),
];
const addresses = [
  ...new Set([
    '127.0.0.1',
    ...localAddresses,
    ...extra.filter((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value)),
  ]),
];
if ([...names, ...addresses].some((value) => !/^[a-zA-Z0-9._-]+$/.test(value)))
  throw new Error(
    'SHOAL_LAN_HOSTS must contain comma-separated hostnames or IPv4 addresses.',
  );
const san = [
  ...names.map((value) => 'DNS:' + value),
  ...addresses.map((value) => 'IP:' + value),
]
  .sort()
  .join(',');
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  console.error('npm run lan needs the openssl command on PATH to create local HTTPS certificates.');
  process.exit(1);
}
const openssl = (...args) =>
  execFileSync('openssl', args, {
    cwd: directory,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
if (!existsSync(resolve(directory, 'ca.crt'))) {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:3072',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-sha256',
    '-days',
    '3650',
    '-subj',
    '/CN=Shoal Local Workspace CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
  );
  chmodSync(resolve(directory, 'ca.key'), 0o600);
}
let renew =
  !existsSync(resolve(directory, 'server.crt')) ||
  !existsSync(resolve(directory, 'names.txt')) ||
  readFileSync(resolve(directory, 'names.txt'), 'utf8') !== san;
if (!renew) {
  try {
    openssl('x509', '-checkend', '604800', '-noout', '-in', 'server.crt');
  } catch {
    renew = true;
  }
}
if (renew) {
  writeFileSync(
    resolve(directory, 'server.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=' +
      san +
      '\n',
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
    '-subj',
    '/CN=Shoal Workspace',
  );
  openssl(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-out',
    'server.crt',
    '-days',
    '365',
    '-sha256',
    '-extfile',
    'server.ext',
  );
  chmodSync(resolve(directory, 'server.key'), 0o600);
  writeFileSync(resolve(directory, 'names.txt'), san);
}
const port = Number(process.env.SHOAL_HTTPS_PORT || 8443),
  upstreamPort = Number(process.env.PORT || 3000);
const allowed = new Set(
  [...names, ...addresses].map((value) => value.toLowerCase()),
);
const server = createServer(
  {
    key: readFileSync(resolve(directory, 'server.key')),
    cert: readFileSync(resolve(directory, 'server.crt')),
    minVersion: 'TLSv1.2',
  },
  (req, res) => {
    let host;
    try {
      host = new URL('https://' + req.headers.host).hostname.toLowerCase();
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!allowed.has(host)) {
      res.writeHead(403).end('Use a configured workspace address.');
      return;
    }
    const headers = {
      ...req.headers,
      'x-shoal-https': '1',
      'x-forwarded-proto': 'https',
    };
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-for'];
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers,
      },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end('Workspace is starting. Retry in a moment.');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  },
);
server.requestTimeout = 120000;
server.headersTimeout = 30000;
server.timeout = 0;
// Next's development client waits for its hot-reload socket before hydrating.
if (process.env.SHOAL_DEV === '1')
  server.on('upgrade', (req, socket, head) => {
    try {
      if (
        !allowed.has(
          new URL('https://' + req.headers.host).hostname.toLowerCase(),
        ) ||
        new URL(req.headers.origin).host !== req.headers.host ||
        !['/_next/webpack-hmr', '/_next/hmr'].includes(req.url.split('?')[0])
      )
        throw new Error();
    } catch {
      socket.destroy();
      return;
    }
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: upstreamPort,
      path: req.url,
      headers: {
        ...req.headers,
        'x-shoal-https': '1',
        'x-forwarded-proto': 'https',
      },
    });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          Object.entries(response.headers)
            .map(([key, value]) => `${key}: ${[value].flat().join(', ')}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      socket.pipe(remote);
      remote.pipe(socket);
      socket.on('error', () => remote.destroy());
      remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy());
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', () => socket.destroy());
    upstream.end();
  });
server.listen(port, process.env.SHOAL_LAN_BIND || '0.0.0.0', () => {
  console.log(
    'LAN workspace: ' +
      [...localAddresses, ...extra]
        .map((address) => `https://${address}:${port}`)
        .join(' · '),
  );
  console.log(
    'Trust this public certificate on each client: ' +
      resolve(directory, 'ca.crt'),
  );
  console.log(
    openssl('x509', '-in', 'ca.crt', '-noout', '-fingerprint', '-sha256')
      .toString()
      .trim(),
  );
});
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    server.closeAllConnections();
  });
