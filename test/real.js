'use strict';

const assert = require('assert');
const request = require('..');

const UA = { 'user-agent': 'reqly-http-real-tests' };
const HTTPBIN = process.env.HTTPBIN_URL || 'https://httpbin.org';
const NET_ERRORS = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);

class Skip extends Error {}
const groups = [];
function group(name, url, setup) {
  const tests = [];
  setup((n, f) => tests.push([n, f]));
  groups.push({ name, url, tests });
}

async function reachable(url) {
  try {
    const r = await request.get(url, { headers: UA, timeout: 8000, retries: 1, retryDelay: 300 });
    return r.statusCode < 500;
  } catch (_) { return false; }
}

const skipOnRateLimit = (res) => {
  if ((res.statusCode === 403 || res.statusCode === 429) && /rate limit/i.test(JSON.stringify(res.body))) {
    throw new Skip('rate limit do GitHub');
  }
};

group('github/npm', 'https://registry.npmjs.org/express', (test) => {
  const npm = request.defaults({ baseUrl: 'https://registry.npmjs.org', json: true, headers: UA, timeout: 20000 });
  const gh = request.defaults({ baseUrl: 'https://api.github.com', json: true, headers: UA, timeout: 20000 });

  test('npm registry: JSON grande com compressão (gzip/br)', async () => {
    const res = await npm.get('/express');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.name, 'express');
    assert.ok(Object.keys(res.body.versions).length > 50);
    assert.ok(res.headers['content-encoding'], 'servidor deveria comprimir');
  });
  test('npm registry: pacote inexistente retorna 404 sem erro', async () => {
    const res = await npm.get('/reqly-http-pacote-que-nao-existe-' + Date.now());
    assert.strictEqual(res.statusCode, 404);
  });
  test('GitHub API: GET com headers e JSON', async () => {
    const res = await gh.get('/repos/nodejs/node');
    skipOnRateLimit(res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.full_name, 'nodejs/node');
  });
  test('GitHub API: 404 com corpo JSON', async () => {
    const res = await gh.get('/users/reqly-http-usuario-inexistente-' + Date.now());
    skipOnRateLimit(res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.message, 'Not Found');
  });
  test('GitHub API: qs repassado', async () => {
    const res = await gh.get('/repos/nodejs/node/issues', { qs: { per_page: 2, state: 'closed' } });
    skipOnRateLimit(res);
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body) && res.body.length === 2);
  });
  test('redirect real (github.com -> codeload) com HEAD', async () => {
    const res = await request.head('https://github.com/nodejs/node/archive/refs/tags/v20.0.0.zip', { headers: UA, timeout: 20000 });
    assert.ok(res.request.redirects.length >= 1);
    assert.strictEqual(res.statusCode, 200);
    assert.match(res.headers['content-type'], /zip|octet-stream/);
  });
  test('stream/pipe de arquivo real (raw.githubusercontent.com)', async () => {
    const { Writable } = require('stream');
    let size = 0;
    let head = '';
    const w = new Writable({ write(c, _e, n) { if (head.length < 4000) head += c.toString(); size += c.length; n(); } });
    await new Promise((resolve, reject) =>
      request.get('https://raw.githubusercontent.com/nodejs/node/main/README.md', { headers: UA }).pipe(w).on('finish', resolve).on('error', reject));
    assert.ok(size > 2000);
    assert.ok(head.includes('Node.js'));
  });
  test('keep-alive (forever) em 2 requisições HTTPS reais', async () => {
    const a = await npm.get('/express', { forever: true, qs: { a: 1 } });
    const b = await npm.get('/express', { forever: true, qs: { b: 1 } });
    assert.strictEqual(a.statusCode, 200);
    assert.strictEqual(b.statusCode, 200);
  });
  test('5 requisições HTTPS em paralelo', async () => {
    const rs = await Promise.all(['express', 'lodash', 'react', 'chalk', 'debug'].map((p) => npm.get('/' + p + '/latest')));
    assert.ok(rs.every((r) => r.statusCode === 200 && r.body.name));
  });
  test('timeout real (1ms) gera ETIMEDOUT', async () => {
    await assert.rejects(request.get('https://registry.npmjs.org/express', { timeout: 1 }), (e) => e.code === 'ETIMEDOUT');
  });
  test('DNS inexistente rejeita com ENOTFOUND/EAI_AGAIN', async () => {
    await assert.rejects(request.get('https://reqly-http-host-que-nao-existe-12345.invalid/'), (e) => ['ENOTFOUND', 'EAI_AGAIN'].includes(e.code));
  });
  test('certificado inválido real (self-signed.badssl.com) é rejeitado', async () => {
    let r;
    try { r = await request.get('https://self-signed.badssl.com/', { timeout: 8000 }); }
    catch (e) { return assert.ok(/self.signed|SELF_SIGNED|CERT/i.test(e.message + e.code) || NET_ERRORS.has(e.code)); }
    throw new Error('deveria rejeitar certificado inválido, status ' + r.statusCode);
  });
});

group('httpbin', HTTPBIN + '/get', (test) => {
  const hb = request.defaults({ baseUrl: HTTPBIN, json: true, headers: UA, timeout: 25000, retries: 2, retryDelay: 500 });

  test('GET com qs', async () => {
    const res = await hb.get('/get', { qs: { x: 1, y: ['a', 'b'] } });
    assert.strictEqual(res.body.args.x, '1');
    assert.deepStrictEqual(res.body.args.y, ['a', 'b']);
  });
  test('POST json', async () => {
    const res = await hb.post('/post', { body: { nome: 'Zypher', n: [1, 2] } });
    assert.deepStrictEqual(res.body.json, { nome: 'Zypher', n: [1, 2] });
  });
  test('POST form', async () => {
    const res = await hb.post('/post', { form: { a: '1', b: 'dois' } });
    assert.deepStrictEqual(res.body.form, { a: '1', b: 'dois' });
  });
  test('POST multipart', async () => {
    const res = await hb.post('/post', { formData: { a: '1', f: { value: Buffer.from('conteudo'), options: { filename: 'x.txt', contentType: 'text/plain' } } } });
    assert.strictEqual(res.body.form.a, '1');
    assert.strictEqual(res.body.files.f, 'conteudo');
  });
  test('status 418 não é erro', async () => {
    assert.strictEqual((await hb.get('/status/418')).statusCode, 418);
  });
  test('3 redirects', async () => {
    const res = await hb.get('/redirect/3');
    assert.strictEqual(res.request.redirects.length, 3);
    assert.ok(res.body.url.endsWith('/get'));
  });
  test('followRedirect:false', async () => {
    assert.strictEqual((await hb.get('/redirect/1', { followRedirect: false })).statusCode, 302);
  });
  test('basic auth e bearer', async () => {
    assert.strictEqual((await hb.get('/basic-auth/user/pass', { auth: { user: 'user', pass: 'pass' } })).body.authenticated, true);
    assert.strictEqual((await hb.get('/bearer', { auth: { bearer: 'tok' } })).body.token, 'tok');
    assert.strictEqual((await hb.get('/basic-auth/user/pass', { auth: { user: 'user', pass: 'errada' } })).statusCode, 401);
  });
  test('cookies com jar através de redirect', async () => {
    const jar = request.jar();
    const res = await hb.get('/cookies/set', { qs: { a: '1', b: '2' }, jar });
    assert.deepStrictEqual(res.body.cookies, { a: '1', b: '2' });
  });
  test('gzip, deflate e brotli', async () => {
    assert.strictEqual((await hb.get('/gzip')).body.gzipped, true);
    assert.strictEqual((await hb.get('/deflate')).body.deflated, true);
    assert.strictEqual((await hb.get('/brotli')).body.brotli, true);
  });
  test('bytes via pipe', async () => {
    const { Writable } = require('stream');
    let n = 0;
    const w = new Writable({ write(c, _e, cb) { n += c.length; cb(); } });
    await new Promise((resolve, reject) => request.get(HTTPBIN + '/bytes/20000', { headers: UA }).pipe(w).on('finish', resolve).on('error', reject));
    assert.strictEqual(n, 20000);
  });
  test('timeout (/delay/3 com 1s)', async () => {
    await assert.rejects(hb.get('/delay/3', { timeout: 1000, retries: 0 }), (e) => e.code === 'ETIMEDOUT');
  });
  test('retry em 503 real', async () => {
    let retries = 0;
    const r = hb.get('/status/503', { retries: 2, retryDelay: 50 });
    r.on('retry', () => retries++);
    const res = await r;
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(retries, 2);
  });
  test('headers customizados e user-agent', async () => {
    const res = await hb.get('/headers', { headers: { 'x-teste': 'reqly-http' } });
    assert.strictEqual(res.body.headers['X-Teste'], 'reqly-http');
    assert.strictEqual(res.body.headers['User-Agent'], 'reqly-http-real-tests');
  });
});

(async () => {
  let failed = 0;
  let passed = 0;
  let skipped = 0;
  for (const g of groups) {
    if (!(await reachable(g.url))) {
      console.log(`\n[${g.name}] pulado: ${g.url} inacessível`);
      skipped += g.tests.length;
      continue;
    }
    console.log(`\n[${g.name}]`);
    for (const [name, fn] of g.tests) {
      try { await fn(); passed++; console.log('  ✓', name); }
      catch (e) {
        if (e instanceof Skip) { skipped++; console.log('  -', name, '(pulado: ' + e.message + ')'); }
        else { failed++; console.log('  ✗', name, '\n    ', e && e.message); }
      }
    }
  }
  console.log(`\n${passed} ok, ${failed} falhou(ram), ${skipped} pulado(s)`);
  process.exit(failed ? 1 : 0);
})();
