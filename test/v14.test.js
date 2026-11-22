'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Writable } = require('stream');
const request = require('..');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const sendBytes = (bytes, type) => (req, res) => {
  res.setHeader('content-type', type);
  res.end(Buffer.from(bytes));
};

test('charset windows-1252 via TextDecoder', async () => {
  const { server, url } = await listen(sendBytes([0x80, 0x20, 0x61], 'text/plain; charset=windows-1252'));
  try {
    assert.strictEqual((await request.get(url)).body, '€ a');
  } finally {
    server.close();
  }
});

test('charset shift_jis e windows-1251', async () => {
  const a = await listen(sendBytes([0x82, 0xa0], 'text/plain; charset=shift_jis'));
  const b = await listen(sendBytes([0xcf, 0xf0], 'text/plain; charset=windows-1251'));
  try {
    assert.strictEqual((await request.get(a.url)).body, 'あ');
    assert.strictEqual((await request.get(b.url)).body, 'Пр');
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('charset desconhecido cai para utf8', async () => {
  const { server, url } = await listen(sendBytes([0x6f, 0x6b], 'text/plain; charset=nao-existe'));
  try {
    assert.strictEqual((await request.get(url)).body, 'ok');
  } finally {
    server.close();
  }
});

test('opcao encoding aceita label do TextDecoder', async () => {
  const { server, url } = await listen(sendBytes([0xcf, 0xf0], 'text/plain'));
  try {
    assert.strictEqual((await request.get(url, { encoding: 'windows-1251' })).body, 'Пр');
    assert.strictEqual((await request.get(url, { encoding: 'latin1' })).body, 'Ïð');
  } finally {
    server.close();
  }
});

test('socketPath fala com socket unix', async () => {
  if (process.platform === 'win32') return;
  const sock = path.join(os.tmpdir(), 'reqly-' + process.pid + '-' + Date.now() + '.sock');
  const server = http.createServer((req, res) => res.end('unix:' + req.url + ':' + req.headers.host));
  await new Promise((r) => server.listen(sock, r));
  try {
    const res = await request.get('http://localhost/hello?a=1', { socketPath: sock });
    assert.strictEqual(res.body, 'unix:/hello?a=1:localhost');
  } finally {
    server.close();
  }
});

test('maxConcurrent limita requisicoes por host', async () => {
  let active = 0;
  let peak = 0;
  const { server, url } = await listen((req, res) => {
    active++;
    peak = Math.max(peak, active);
    setTimeout(() => {
      active--;
      res.end(req.url);
    }, 60);
  });
  try {
    const all = await Promise.all(
      Array.from({ length: 8 }, (_, i) => request.get(url + '/' + i, { maxConcurrent: 2 }))
    );
    assert.deepStrictEqual(all.map((r) => r.body), Array.from({ length: 8 }, (_, i) => '/' + i));
    assert.strictEqual(peak, 2);
    const t = await Promise.all(Array.from({ length: 4 }, () => request.get(url, {})));
    assert.strictEqual(t.length, 4);
    assert.ok(peak >= 3, 'sem maxConcurrent nao deve limitar');
  } finally {
    server.close();
  }
});

test('maxConcurrent: abort na fila libera a vez dos outros', async () => {
  if (typeof AbortController === 'undefined') return;
  let hits = 0;
  const { server, url } = await listen((req, res) => {
    hits++;
    setTimeout(() => res.end('ok'), 100);
  });
  try {
    const ac = new AbortController();
    const first = request.get(url, { maxConcurrent: 1 });
    const queued = request.get(url, { maxConcurrent: 1, signal: ac.signal });
    const third = request.get(url, { maxConcurrent: 1 });
    await sleep(30);
    ac.abort();
    await assert.rejects(queued, (e) => e.code === 'ABORTED');
    assert.strictEqual((await first).body, 'ok');
    assert.strictEqual((await third).body, 'ok');
    assert.strictEqual(hits, 2);
  } finally {
    server.close();
  }
});

test('maxConcurrent: erro libera a vaga', async () => {
  const { server, url } = await listen((req, res) => res.end('ok'));
  try {
    await assert.rejects(request.get('ftp://127.0.0.1/x', { maxConcurrent: 1 }), /Invalid protocol/);
    const res = await request.get(url, { maxConcurrent: 1 });
    assert.strictEqual(res.body, 'ok');
  } finally {
    server.close();
  }
});

function etagServer() {
  const state = { etag: '"v1"', body: 'primeira', full: 0, cond: 0 };
  return listen((req, res) => {
    if (req.headers['if-none-match'] === state.etag) {
      state.cond++;
      res.statusCode = 304;
      return res.end();
    }
    state.full++;
    res.setHeader('etag', state.etag);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ v: state.body }));
  }).then((s) => Object.assign(s, { state }));
}

test('cache ETag: 304 devolve corpo do cache', async () => {
  const { server, url, state } = await etagServer();
  try {
    const cache = new Map();
    const a = await request.get(url, { cache, json: true });
    assert.deepStrictEqual(a.body, { v: 'primeira' });
    assert.ok(!a.fromCache);

    const b = await request.get(url, { cache, json: true });
    assert.strictEqual(b.statusCode, 200);
    assert.strictEqual(b.fromCache, true);
    assert.deepStrictEqual(b.body, { v: 'primeira' });
    assert.strictEqual(b.headers['content-type'], 'application/json');
    assert.strictEqual(state.full, 1);
    assert.strictEqual(state.cond, 1);

    state.etag = '"v2"';
    state.body = 'segunda';
    const c = await request.get(url, { cache, json: true });
    assert.ok(!c.fromCache);
    assert.deepStrictEqual(c.body, { v: 'segunda' });
    const d = await request.get(url, { cache, json: true });
    assert.strictEqual(d.fromCache, true);
    assert.deepStrictEqual(d.body, { v: 'segunda' });
  } finally {
    server.close();
  }
});

test('cache true usa cache global; sem cache nao envia condicional', async () => {
  const { server, url, state } = await etagServer();
  try {
    await request.get(url, { cache: true });
    const b = await request.get(url, { cache: true });
    assert.strictEqual(b.fromCache, true);
    await request.get(url);
    assert.strictEqual(state.cond, 1);
    assert.strictEqual(state.full, 2);
  } finally {
    server.close();
  }
});

test('cache com Last-Modified e no-store', async () => {
  let cond = 0;
  const lm = 'Wed, 21 Oct 2015 07:28:00 GMT';
  const a = await listen((req, res) => {
    if (req.headers['if-modified-since'] === lm) {
      cond++;
      res.statusCode = 304;
      return res.end();
    }
    res.setHeader('last-modified', lm);
    res.end('conteudo');
  });
  const b = await listen((req, res) => {
    res.setHeader('etag', '"x"');
    res.setHeader('cache-control', 'no-store');
    res.end('segredo');
  });
  try {
    const cache = new Map();
    await request.get(a.url, { cache });
    const r = await request.get(a.url, { cache });
    assert.strictEqual(r.body, 'conteudo');
    assert.strictEqual(r.fromCache, true);
    assert.strictEqual(cond, 1);

    const c2 = new Map();
    await request.get(b.url, { cache: c2 });
    assert.strictEqual(c2.size, 0);
  } finally {
    a.server.close();
    b.server.close();
  }
});

test('cache: 304 tambem alimenta pipe e callback', async () => {
  const { server, url } = await etagServer();
  try {
    const cache = new Map();
    await request.get(url, { cache });
    const chunks = [];
    const sink = new Writable({
      write(c, enc, cb) {
        chunks.push(c);
        cb();
      }
    });
    await new Promise((resolve, reject) => {
      request(url, { cache }).pipe(sink).on('finish', resolve).on('error', reject);
    });
    assert.strictEqual(Buffer.concat(chunks).toString(), '{"v":"primeira"}');

    await new Promise((resolve) => {
      request(url, { cache }, (err, res, body) => {
        assert.ifError(err);
        assert.strictEqual(res.fromCache, true);
        assert.strictEqual(body, '{"v":"primeira"}');
        resolve();
      });
    });
  } finally {
    server.close();
  }
});

function collect(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

test('multipart com arquivo envia em stream e com content-length', async () => {
  const file = path.join(os.tmpdir(), 'reqly-up-' + process.pid + '.bin');
  const content = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(file, content);
  let seen;
  const { server, url } = await listen(async (req, res) => {
    const buf = await collect(req);
    seen = { headers: req.headers, buf };
    res.end('ok');
  });
  try {
    const res = await request.post(url, {
      formData: { nome: 'valor', arquivo: fs.createReadStream(file), extra: Buffer.from('xyz') }
    });
    assert.strictEqual(res.body, 'ok');
    assert.strictEqual(Number(seen.headers['content-length']), seen.buf.length);
    assert.ok(!seen.headers['transfer-encoding']);
    const text = seen.buf.toString('latin1');
    assert.ok(text.includes('name="nome"\r\n\r\nvalor\r\n'));
    assert.ok(text.includes('filename="' + path.basename(file) + '"'));
    assert.ok(text.includes('name="extra"'));
    assert.ok(seen.buf.includes(content));
    assert.ok(text.endsWith('--\r\n'));
  } finally {
    server.close();
    await sleep(50);
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('multipart com stream de tamanho desconhecido usa chunked', async () => {
  let seen;
  const { server, url } = await listen(async (req, res) => {
    seen = { headers: req.headers, buf: await collect(req) };
    res.end('ok');
  });
  try {
    const stream = Readable.from([Buffer.from('aaa'), Buffer.from('bbb')]);
    await request.post(url, { formData: { f: { value: stream, options: { filename: 'x.txt' } } } });
    assert.strictEqual(seen.headers['transfer-encoding'], 'chunked');
    assert.ok(seen.buf.toString().includes('filename="x.txt"\r\nContent-Type: text/plain\r\n\r\naaabbb\r\n'));
  } finally {
    server.close();
  }
});

test('multipart: knownLength define o content-length', async () => {
  let seen;
  const { server, url } = await listen(async (req, res) => {
    seen = { headers: req.headers, buf: await collect(req) };
    res.end('ok');
  });
  try {
    const stream = Readable.from([Buffer.from('12345')]);
    await request.post(url, {
      formData: { f: { value: stream, options: { filename: 'n.bin', knownLength: 5 } } }
    });
    assert.strictEqual(Number(seen.headers['content-length']), seen.buf.length);
  } finally {
    server.close();
  }
});

test('multipart: erro no stream rejeita a requisicao', async () => {
  const { server, url } = await listen((req, res) => {
    req.resume();
    req.on('end', () => res.end('ok'));
  });
  try {
    const bad = new Readable({
      read() {
        this.destroy(new Error('stream quebrou'));
      }
    });
    await assert.rejects(request.post(url, { formData: { f: { value: bad, options: { filename: 'a' } } } }), /stream quebrou/);
  } finally {
    server.close();
  }
});

test('multipart so com texto continua em Buffer (retry funciona)', async () => {
  let n = 0;
  const { server, url } = await listen(async (req, res) => {
    n++;
    await collect(req);
    if (n === 1) {
      res.statusCode = 503;
      return res.end('x');
    }
    res.end('ok');
  });
  try {
    const res = await request.put(url, { formData: { a: 'b' }, retries: 1, retryDelay: 1 });
    assert.strictEqual(res.body, 'ok');
    assert.strictEqual(n, 2);
  } finally {
    server.close();
  }
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log('ok   ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL ' + name);
      console.log(err && err.stack ? err.stack : err);
    }
  }
  console.log(tests.length - failed + '/' + tests.length + ' passaram');
  process.exit(failed ? 1 : 0);
})();
