/** Real HTTP response-boundary tests for the OAuth transport. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';

const { rawOAuthHttpTransport } = await import('../dist/remote-device/oauth-http.js');
const { readBoundedJsonObject } = await import('../dist/remote-device/device-oauth.js');

const LIMIT = 64;
const exactBody = JSON.stringify({ x: 'a'.repeat(LIMIT - 8) });
assert.equal(Buffer.byteLength(exactBody), LIMIT);

let redirectBytesSent = 0;
let resolveRedirectClosed;
const redirectClosed = new Promise((resolve) => { resolveRedirectClosed = resolve; });

const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  if (pathname === '/chunked-ok') {
    response.setHeader('content-type', 'application/json');
    response.write('{"ok":');
    response.end('true}');
    return;
  }
  if (pathname === '/chunked-large') {
    response.setHeader('content-type', 'application/json');
    response.write('{"x":"');
    response.end(`${'x'.repeat(LIMIT + 20)}"}`);
    return;
  }
  if (pathname === '/redirect-stream') {
    response.writeHead(302, {
      location: '/chunked-ok',
      'content-type': 'text/plain',
    });
    response.flushHeaders();
    const chunk = Buffer.alloc(8192, 'r');
    const timer = setInterval(() => {
      if (response.destroyed) {
        clearInterval(timer);
        return;
      }
      redirectBytesSent += chunk.length;
      response.write(chunk);
    }, 5);
    response.once('close', () => {
      clearInterval(timer);
      resolveRedirectClosed();
    });
    return;
  }
  if (pathname === '/compressed') {
    const body = gzipSync(Buffer.from('{"ok":true}'));
    response.setHeader('content-type', 'application/json');
    response.setHeader('content-encoding', 'gzip');
    response.setHeader('content-length', String(body.length));
    response.end(body);
    return;
  }
  if (pathname === '/declared-large') {
    response.setHeader('content-type', 'application/json');
    response.setHeader('content-length', String(LIMIT + 100));
    response.end('{}');
    return;
  }
  if (pathname === '/truncated') {
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': '40',
    });
    response.write('{"ok":');
    response.socket.destroy();
    return;
  }
  if (pathname === '/exact') {
    response.setHeader('content-type', 'application/json');
    response.setHeader('content-length', String(Buffer.byteLength(exactBody)));
    response.end(exactBody);
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not_found"}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.equal(typeof address, 'object');
const base = `http://127.0.0.1:${address.port}`;

async function get(pathname, limit = LIMIT) {
  return rawOAuthHttpTransport(`${base}${pathname}`, {
    headers: { accept: 'application/json', 'accept-encoding': 'identity' },
  }, limit);
}

try {
  const chunked = await get('/chunked-ok');
  assert.deepEqual(await readBoundedJsonObject(chunked, { maxBytes: LIMIT }), { ok: true });

  await assert.rejects(() => get('/chunked-large'), /raw body bytes/);
  await assert.rejects(() => get('/declared-large'), /raw body bytes/);

  const redirectStartedAt = Date.now();
  await assert.rejects(() => get('/redirect-stream'), /redirects are not allowed/);
  await Promise.race([
    redirectClosed,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error('redirect response socket was not closed promptly')),
      500,
    )),
  ]);
  assert.ok(Date.now() - redirectStartedAt < 500, 'redirect socket should close promptly');
  assert.ok(redirectBytesSent < 64 * 1024, `redirect body kept streaming (${redirectBytesSent} bytes)`);

  const compressed = await get('/compressed');
  await assert.rejects(
    () => readBoundedJsonObject(compressed, { maxBytes: LIMIT }),
    /identity content encoding/,
  );
  await assert.rejects(() => get('/truncated'), /aborted|terminated|socket hang up/i);

  const exact = await get('/exact');
  const exactJson = await readBoundedJsonObject(exact, { maxBytes: LIMIT });
  assert.equal(exactJson.x.length, LIMIT - 8);

  console.log('✓ OAuth raw HTTP transport enforces byte bounds and terminates redirect streams');
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}
