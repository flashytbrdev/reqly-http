'use strict';
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Writable, Readable } = require('stream');

for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[k];
const request = require('..');

const KEY = fs.readFileSync(path.join(__dirname, 'fixtures', 'key.pem'));
const CERT = fs.readFileSync(path.join(__dirname, 'fixtures', 'cert.pem'));
const counters = {};
let connections = 0;

function handler(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    const u = new URL(req.url, 'http://x');
    const q = Object.fromEntries(u.searchParams);
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const hit = () => (counters[q.id] = (counters[q.id] || 0) + 1);
    switch (u.pathname) {
      case '/json': return send(200, { ok: true });
      case '/echo': return send(200, { method: req.method, ct: req.headers['content-type'], body });
      case '/url': return send(200, { url: req.url, host: req.headers.host });
      case '/redirect': res.writeHead(302, { location: '/json' }); return res.end();
      case '/redirect307': res.writeHead(307, { location: '/echo' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/gzip':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        return res.end(zlib.gzipSync(JSON.stringify({ gz: true })));
      case '/deflate':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'deflate' });
        return res.end(zlib.deflateSync(JSON.stringify({ df: true })));
      case '/br':
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'br' });
        return res.end(zlib.brotliCompressSync(JSON.stringify({ br: true })));
      case '/slow': return;
      case '/auth': return send(200, { auth: req.headers.authorization || null });
      case '/text': res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('olá');
      case '/latin1': res.writeHead(200, { 'content-type': 'text/plain; charset=iso-8859-1' }); return res.end(Buffer.from('olá', 'latin1'));
      case '/bom': res.writeHead(200, { 'content-type': 'application/json' }); return res.end('\uFEFF{"a":1}');
      case '/big': res.writeHead(200, { 'content-length': 20 * 1024 * 1024 }); return res.end(Buffer.alloc(20 * 1024 * 1024, 97));
      case '/upload': return send(200, { bytes: raw.length, te: req.headers['transfer-encoding'] || null });
      case '/multipart': return send(200, { ct: req.headers['content-type'], body });
      case '/truncate':
        res.writeHead(200, { 'content-length': 100 });
        res.write('0123456789');
        return setTimeout(() => res.socket.destroy(), 20);
      case '/flaky': {
        const n = hit();
        if (n <= Number(q.fail)) return send(503, { n }, q.ra ? { 'retry-after': q.ra } : {});
        return send(200, { n });
      }
      case '/reset': {
        const n = hit();
        if (n <= Number(q.fail)) return req.socket.destroy();
        return send(200, { n });
      }
      case '/cookie-set':
        return send(200, { ok: 1 }, { 'set-cookie': ['a=1; Path=/', 'b=2; Path=/x', 'c=3; Max-Age=0', 'd=4; Domain=evil.com'] });
      case '/cookie-echo': return send(200, { cookie: req.headers.cookie || '' });
      case '/login': res.writeHead(302, { location: '/cookie-echo', 'set-cookie': 'sid=xyz; Path=/' }); return res.end();
      case '/logout': return send(200, {}, { 'set-cookie': 'sid=; Max-Age=0; Path=/' });
      default: return send(404, { error: 'nf' });
    }
  });
}

const listen = (srv, host = '127.0.0.1') => new Promise((res, rej) => { srv.once('error', rej); srv.listen(0, host, () => res(srv.address().port)); });
const cbp = (fn) => new Promise((resolve) => fn((err, res, body) => resolve({ err, res, body })));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

(async () => {
  const server = http.createServer(handler);
  server.on('connection', () => connections++);
  const secure = https.createServer({ key: KEY, cert: CERT }, handler);
  const port = await listen(server);
  const sport = await listen(secure);
  const base = 'http://127.0.0.1:' + port;
  const sbase = 'https://localhost:' + sport;
  const api = request.defaults({ baseUrl: base, json: true });
  const sapi = request.defaults({ baseUrl: sbase, json: true, ca: CERT });

  const proxyLog = [];
  const proxy = http.createServer((req, res) => {
    const u = new URL(req.url);
    proxyLog.push({ url: req.url, auth: req.headers['proxy-authorization'] });
    const up = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method: req.method, headers: { ...req.headers, host: u.host } }, (ur) => {
      res.writeHead(ur.statusCode, { ...ur.headers, 'x-proxied': '1' });
      ur.pipe(res);
    });
    req.pipe(up);
  });
  proxy.on('connect', (req, client, head) => {
    proxyLog.push({ connect: req.url, auth: req.headers['proxy-authorization'] });
    const target = net.connect(Number(req.url.split(':')[1]), '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      target.write(head); target.pipe(client); client.pipe(target);
    });
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
  });
  const pport = await listen(proxy);
  const purl = 'http://127.0.0.1:' + pport;

  test('callback + json', async () => {
    const { err, res, body } = await cbp((cb) => request(base + '/json', { json: true }, cb));
    assert.ifError(err);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(body, { ok: true });
  });
  test('promise (await)', async () => {
    const res = await api.get('/json');
    assert.deepStrictEqual(res.body, { ok: true });
  });
  test('POST json', async () => {
    const res = await api.post('/echo', { body: { a: 1 } });
    assert.strictEqual(res.body.ct, 'application/json');
    assert.strictEqual(res.body.body, '{"a":1}');
  });
  test('POST form', async () => {
    const res = await api.post('/echo', { form: { x: 'a b', y: [1, 2] } });
    assert.strictEqual(res.body.body, 'x=a+b&y=1&y=2');
  });
  test('qs', async () => {
    const res = await api.get('/url', { qs: { q: 'oi', n: [1, 2] } });
    assert.strictEqual(res.body.url, '/url?q=oi&n=1&n=2');
  });
  test('404 não é erro', async () => {
    const res = await api.get('/nada');
    assert.strictEqual(res.statusCode, 404);
  });
  test('HEAD', async () => {
    const res = await request.head(base + '/json');
    assert.strictEqual(res.body, '');
  });
  test('texto, encoding null, charset latin1, BOM, jsonReviver', async () => {
    assert.strictEqual((await request.get(base + '/text')).body, 'olá');
    assert.ok(Buffer.isBuffer((await request.get(base + '/text', { encoding: null })).body));
    assert.strictEqual((await request.get(base + '/latin1')).body, 'olá');
    assert.deepStrictEqual((await api.get('/bom')).body, { a: 1 });
    const r = await api.get('/json', { jsonReviver: (k, v) => (k === 'ok' ? 'sim' : v) });
    assert.strictEqual(r.body.ok, 'sim');
  });
  test('auth basic e bearer', async () => {
    const a = await api.get('/auth', { auth: { user: 'u', pass: 'p' } });
    assert.strictEqual(a.body.auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
    assert.strictEqual((await api.get('/auth', { auth: { bearer: 'tok' } })).body.auth, 'Bearer tok');
  });

  test('redirect GET + followRedirect:false', async () => {
    const res = await api.get('/redirect');
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(res.request.redirects.length, 1);
    assert.strictEqual((await api.get('/redirect', { followRedirect: false })).statusCode, 302);
  });
  test('307 POST mantém body', async () => {
    const res = await api.post('/redirect307', { body: { k: 1 }, followAllRedirects: true });
    assert.strictEqual(res.body.method, 'POST');
    assert.strictEqual(res.body.body, '{"k":1}');
  });
  test('loop de redirect', async () => {
    await assert.rejects(api.get('/loop', { maxRedirects: 3 }), /maxRedirects/);
  });

  test('gzip, deflate e brotli', async () => {
    assert.deepStrictEqual((await api.get('/gzip')).body, { gz: true });
    assert.deepStrictEqual((await api.get('/deflate')).body, { df: true });
    assert.deepStrictEqual((await api.get('/br')).body, { br: true });
  });

  test('HTTPS com ca', async () => {
    assert.deepStrictEqual((await sapi.get('/json')).body, { ok: true });
  });
  test('HTTPS self-signed é rejeitado por padrão', async () => {
    await assert.rejects(request.get(sbase + '/json'), /self.signed|SELF_SIGNED|unable to verify/i);
  });
  test('HTTPS strictSSL:false', async () => {
    assert.strictEqual((await request.get(sbase + '/json', { strictSSL: false })).statusCode, 200);
  });
  test('HTTPS POST json', async () => {
    const res = await sapi.post('/echo', { body: { s: 1 } });
    assert.strictEqual(res.body.body, '{"s":1}');
  });

  test('download 20MB via pipe', async () => {
    let bytes = 0;
    const w = new Writable({ write(c, _e, n) { bytes += c.length; n(); } });
    await new Promise((resolve, reject) => {
      request.get(base + '/big').pipe(w).on('finish', resolve).on('error', reject);
    });
    assert.strictEqual(bytes, 20 * 1024 * 1024);
  });
  test('download buffer:false conta bytes por evento', async () => {
    let bytes = 0;
    const r = request.get(base + '/big', { buffer: false });
    r.on('data', (c) => (bytes += c.length));
    const res = await r;
    assert.strictEqual(res.body, undefined);
    assert.strictEqual(bytes, 20 * 1024 * 1024);
  });
  test('upload 10MB via stream (chunked)', async () => {
    const size = 10 * 1024 * 1024;
    let sent = 0;
    const src = new Readable({ read() { if (sent >= size) return this.push(null); sent += 65536; this.push(Buffer.alloc(65536, 1)); } });
    const res = await api.post('/upload', { body: src });
    assert.strictEqual(res.body.bytes, size);
    assert.strictEqual(res.body.te, 'chunked');
  });
  test('maxResponseSize', async () => {
    await assert.rejects(request.get(base + '/big', { maxResponseSize: 1024 }), (e) => e.code === 'ERESPONSETOOLARGE');
  });
  test('pipe pequeno', async () => {
    let out = '';
    const w = new Writable({ write(c, _e, n) { out += c; n(); } });
    await new Promise((resolve, reject) => request.get(base + '/json').pipe(w).on('finish', resolve).on('error', reject));
    assert.strictEqual(out, '{"ok":true}');
  });

  test('multipart: campos, Buffer e arquivo (stream)', async () => {
    const res = await api.post('/multipart', {
      formData: {
        nome: 'Zypher',
        n: 7,
        buf: { value: Buffer.from('conteudo'), options: { filename: 'a.txt', contentType: 'text/plain' } },
        arquivo: fs.createReadStream(__filename),
        lista: ['x', 'y']
      }
    });
    assert.match(res.body.ct, /^multipart\/form-data; boundary=/);
    const b = res.body.body;
    assert.ok(b.includes('name="nome"\r\n\r\nZypher'));
    assert.ok(b.includes('name="n"\r\n\r\n7'));
    assert.ok(b.includes('filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nconteudo'));
    assert.ok(b.includes('filename="test.js"'));
    assert.ok(b.includes("'use strict';"));
    assert.strictEqual((b.match(/form-data; name="lista"\r\n/g) || []).length, 2);
    assert.ok(b.trimEnd().endsWith('--'));
  });

  test('cookie jar: set, path, remoção, domain inválido', async () => {
    const jar = request.jar();
    await api.get('/cookie-set', { jar });
    assert.strictEqual((await api.get('/cookie-echo', { jar })).body.cookie, 'a=1');
    assert.strictEqual((await api.get('/x/../cookie-echo', { jar })).body.cookie, 'a=1');
    assert.strictEqual(jar.getCookieString(base + '/x/y'), 'b=2; a=1');
    assert.strictEqual(jar.getCookieString(base + '/').includes('d=4'), false);
    assert.strictEqual(jar.getCookieString(base + '/').includes('c=3'), false);
  });
  test('cookie jar atravessa redirect e logout', async () => {
    const jar = request.jar();
    const res = await api.get('/login', { jar });
    assert.strictEqual(res.body.cookie, 'sid=xyz');
    await api.get('/logout', { jar });
    assert.strictEqual((await api.get('/cookie-echo', { jar })).body.cookie, '');
  });
  test('jar:true usa jar global; sem jar não envia', async () => {
    await api.get('/login', { jar: true });
    assert.strictEqual((await api.get('/cookie-echo', { jar: true })).body.cookie, 'sid=xyz');
    assert.strictEqual((await api.get('/cookie-echo')).body.cookie, '');
    await api.get('/logout', { jar: true });
    assert.strictEqual((await api.get('/cookie-echo', { jar: true })).body.cookie, '');
  });

  test('retry em 503 (GET)', async () => {
    const res = await api.get('/flaky', { qs: { id: 'a', fail: 2 }, retries: 3, retryDelay: 10 });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.n, 3);
  });
  test('sem retries retorna 503', async () => {
    assert.strictEqual((await api.get('/flaky', { qs: { id: 'b', fail: 1 } })).statusCode, 503);
  });
  test('POST não repete por padrão', async () => {
    const res = await api.post('/flaky', { qs: { id: 'c', fail: 1 }, retries: 3, retryDelay: 10 });
    assert.strictEqual(res.statusCode, 503);
    const ok = await api.post('/flaky', { qs: { id: 'd', fail: 1 }, retries: 3, retryDelay: 10, retryNonIdempotent: true });
    assert.strictEqual(ok.statusCode, 200);
  });
  test('retry em ECONNRESET', async () => {
    const res = await api.get('/reset', { qs: { id: 'e', fail: 2 }, retries: 3, retryDelay: 10 });
    assert.strictEqual(res.body.n, 3);
  });
  test('retry esgotado devolve último 503', async () => {
    const res = await api.get('/flaky', { qs: { id: 'f', fail: 9 }, retries: 1, retryDelay: 5 });
    assert.strictEqual(res.statusCode, 503);
  });
  test('Retry-After é respeitado', async () => {
    const t = Date.now();
    await api.get('/flaky', { qs: { id: 'g', fail: 1, ra: 1 }, retries: 1, retryDelay: 5 });
    assert.ok(Date.now() - t >= 900);
  });

  test('proxy HTTP (alvo http) + proxy auth', async () => {
    proxyLog.length = 0;
    const res = await request.get(base + '/url', { json: true, proxy: 'http://us:pw@127.0.0.1:' + pport });
    assert.strictEqual(res.headers['x-proxied'], '1');
    assert.strictEqual(res.body.host, '127.0.0.1:' + port);
    assert.strictEqual(proxyLog[0].url, base + '/url');
    assert.strictEqual(proxyLog[0].auth, 'Basic ' + Buffer.from('us:pw').toString('base64'));
  });
  test('proxy HTTPS via CONNECT', async () => {
    proxyLog.length = 0;
    const res = await request.get(sbase + '/json', { json: true, ca: CERT, proxy: 'http://u:p@127.0.0.1:' + pport });
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(proxyLog[0].connect, 'localhost:' + sport);
    assert.strictEqual(proxyLog[0].auth, 'Basic ' + Buffer.from('u:p').toString('base64'));
  });
  test('proxy HTTPS POST json via CONNECT', async () => {
    const res = await request.post(sbase + '/echo', { json: { z: 1 }, ca: CERT, proxy: purl });
    assert.strictEqual(res.body.body, '{"z":1}');
  });
  test('proxy por variável de ambiente e NO_PROXY', async () => {
    process.env.HTTP_PROXY = purl;
    try {
      const res = await request.get('http://fake.test:' + port + '/json', { json: true });
      assert.strictEqual(res.headers['x-proxied'], '1');
      process.env.NO_PROXY = 'fake.test';
      await assert.rejects(request.get('http://fake.test:' + port + '/json'));
      delete process.env.NO_PROXY;
      await assert.rejects(request.get('http://fake.test:' + port + '/json', { proxy: false }));
    } finally {
      delete process.env.HTTP_PROXY; delete process.env.NO_PROXY;
    }
  });
  test('proxy inexistente dá erro', async () => {
    await assert.rejects(request.get(sbase + '/json', { ca: CERT, proxy: 'http://127.0.0.1:1' }));
  });

  test('timeout', async () => {
    await assert.rejects(api.get('/slow', { timeout: 150 }), (e) => e.code === 'ETIMEDOUT');
  });
  test('abort', async () => {
    const r = api.get('/slow');
    setTimeout(() => r.abort(), 50);
    await assert.rejects(r, (e) => e.code === 'ABORTED');
  });
  test('resposta truncada gera erro', async () => {
    await assert.rejects(api.get('/truncate'), (e) => e.code === 'ECONNRESET');
  });
  test('ECONNREFUSED via callback', async () => {
    const { err } = await cbp((cb) => request('http://127.0.0.1:1/x', cb));
    assert.strictEqual(err.code, 'ECONNREFUSED');
  });
  test('uri inválida / protocolo inválido / body inválido', async () => {
    await assert.rejects(request({}), /uri is a required/);
    await assert.rejects(request('ftp://x.com/a'), /Invalid protocol/);
    await assert.rejects(request.post(base, { body: { a: 1 } }), /options.body must be/);
  });
  test('keep-alive reutiliza conexão (forever)', async () => {
    const before = connections;
    await request.get(base + '/json', { forever: true });
    await request.get(base + '/json', { forever: true });
    assert.strictEqual(connections - before, 1);
  });
  test('IPv6 literal', async () => {
    const s6 = http.createServer(handler);
    let p6;
    try { p6 = await listen(s6, '::1'); } catch (_) { return; }
    try { assert.deepStrictEqual((await request.get('http://[::1]:' + p6 + '/json', { json: true })).body, { ok: true }); }
    finally { s6.close(); }
  });
  test('muitas requisições concorrentes', async () => {
    const rs = await Promise.all(Array.from({ length: 100 }, () => api.get('/json')));
    assert.ok(rs.every((r) => r.statusCode === 200));
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failed++; console.log('  ✗', name, '\n    ', e && e.message); }
  }
  console.log(failed ? `\n${failed} falhou(ram) de ${tests.length}` : `\n${tests.length} testes ok`);
  process.exit(failed ? 1 : 0);
})();
