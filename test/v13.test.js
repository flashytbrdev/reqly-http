'use strict';

const assert = require('assert');
const http = require('http');
const request = require('..');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: 'http://127.0.0.1:' + server.address().port }));
  });
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('throwHttpErrors rejeita em 4xx com EHTTP', async () => {
  const { server, url } = await listen((req, res) => {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end('{"erro":"nao achei"}');
  });
  try {
    const ok = await request.get(url, { json: true });
    assert.strictEqual(ok.statusCode, 404);

    await assert.rejects(request.get(url, { json: true, throwHttpErrors: true }), (e) => {
      assert.strictEqual(e.code, 'EHTTP');
      assert.strictEqual(e.statusCode, 404);
      assert.deepStrictEqual(e.body, { erro: 'nao achei' });
      assert.strictEqual(e.response.statusCode, 404);
      return true;
    });

    await new Promise((resolve) => {
      request(url, { throwHttpErrors: true }, (err, res) => {
        assert.strictEqual(err.code, 'EHTTP');
        assert.strictEqual(res.statusCode, 404);
        resolve();
      });
    });
  } finally {
    server.close();
  }
});

test('throwHttpErrors nao rejeita em 2xx', async () => {
  const { server, url } = await listen((req, res) => res.end('ok'));
  try {
    const res = await request.get(url, { throwHttpErrors: true });
    assert.strictEqual(res.body, 'ok');
  } finally {
    server.close();
  }
});

if (typeof AbortController !== 'undefined') {
  test('signal cancela requisicao em andamento', async () => {
    const { server, url } = await listen(() => {});
    try {
      const ac = new AbortController();
      const p = request.get(url, { signal: ac.signal });
      setTimeout(() => ac.abort(), 50);
      await assert.rejects(p, (e) => e.code === 'ABORTED');
    } finally {
      server.close();
    }
  });

  test('signal ja abortado nao chega ao servidor', async () => {
    let hits = 0;
    const { server, url } = await listen((req, res) => { hits++; res.end('x'); });
    try {
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(request.get(url, { signal: ac.signal }), (e) => e.code === 'ABORTED');
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(hits, 0);
    } finally {
      server.close();
    }
  });

  test('signal nao interfere em requisicao concluida', async () => {
    const { server, url } = await listen((req, res) => res.end('ok'));
    try {
      const ac = new AbortController();
      const res = await request.get(url, { signal: ac.signal });
      ac.abort();
      assert.strictEqual(res.body, 'ok');
    } finally {
      server.close();
    }
  });
}

test('Retry-After aceita data HTTP', async () => {
  let n = 0;
  const { server, url } = await listen((req, res) => {
    n++;
    if (n === 1) {
      res.statusCode = 503;
      res.setHeader('retry-after', new Date(Date.now() + 1500).toUTCString());
      return res.end('espera');
    }
    res.end('pronto');
  });
  try {
    const t0 = Date.now();
    const res = await request.get(url, { retries: 1, retryDelay: 1 });
    assert.strictEqual(res.body, 'pronto');
    assert.ok(Date.now() - t0 >= 200, 'deveria ter esperado pelo Retry-After');
  } finally {
    server.close();
  }
});

test('redirect para outro host nao reenvia cookie manual', async () => {
  const target = await listen((req, res) => res.end(String(req.headers.cookie || '')));
  const origin = await listen((req, res) => {
    if (req.url === '/cross') {
      res.statusCode = 302;
      res.setHeader('location', target.url + '/');
      return res.end();
    }
    if (req.url === '/same') {
      res.statusCode = 302;
      res.setHeader('location', '/final');
      return res.end();
    }
    res.end(String(req.headers.cookie || ''));
  });
  try {
    const headers = { cookie: 'a=1' };
    const cross = await request.get(origin.url + '/cross', { headers });
    assert.strictEqual(cross.body, '');
    const same = await request.get(origin.url + '/same', { headers });
    assert.strictEqual(same.body, 'a=1');
  } finally {
    target.server.close();
    origin.server.close();
  }
});

test('multipart usa boundary ReqlyBoundary', async () => {
  const { server, url } = await listen((req, res) => res.end(req.headers['content-type']));
  try {
    const res = await request.post(url, { formData: { a: 'b' } });
    assert.ok(res.body.includes('ReqlyBoundary'), res.body);
  } finally {
    server.close();
  }
});

const silent = () => {};

test('timeout.response estoura com phase response', async () => {
  const { server, url } = await listen(silent);
  try {
    await assert.rejects(request.get(url, { timeout: { response: 100 } }), (e) => {
      assert.strictEqual(e.code, 'ETIMEDOUT');
      assert.strictEqual(e.phase, 'response');
      return true;
    });
  } finally {
    server.close();
  }
});

test('timeout numerico continua sendo inatividade', async () => {
  const { server, url } = await listen(silent);
  try {
    await assert.rejects(request.get(url, { timeout: 100 }), (e) => e.code === 'ETIMEDOUT' && e.phase === 'idle');
  } finally {
    server.close();
  }
});

test('timeout.total corta resposta que nao termina', async () => {
  const { server, url } = await listen((req, res) => {
    res.write('x');
    const iv = setInterval(() => res.write('x'), 30);
    res.on('close', () => clearInterval(iv));
  });
  try {
    const t0 = Date.now();
    await assert.rejects(request.get(url, { timeout: { total: 250 } }), (e) => e.code === 'ETIMEDOUT' && e.phase === 'total');
    assert.ok(Date.now() - t0 < 1500);
  } finally {
    server.close();
  }
});

test('timeout.response entra no retry', async () => {
  let n = 0;
  const { server, url } = await listen((req, res) => {
    n++;
    if (n > 1) res.end('ok');
  });
  try {
    const res = await request.get(url, { timeout: { response: 100 }, retries: 1, retryDelay: 1 });
    assert.strictEqual(res.body, 'ok');
    assert.strictEqual(n, 2);
  } finally {
    server.close();
  }
});

test('timeout.connect nao atrapalha requisicao normal', async () => {
  const { server, url } = await listen((req, res) => res.end('ok'));
  try {
    const res = await request.get(url, { timeout: { connect: 5000, response: 5000, total: 5000 } });
    assert.strictEqual(res.body, 'ok');
  } finally {
    server.close();
  }
});

test('hooks beforeRequest (sync e async) alteram headers', async () => {
  const { server, url } = await listen((req, res) => res.end(req.headers['x-a'] + ',' + req.headers['x-b']));
  try {
    const res = await request.get(url, {
      hooks: {
        beforeRequest: [
          (req) => { req.headers['x-a'] = '1'; },
          async (req) => {
            await new Promise((r) => setTimeout(r, 10));
            req.headers['x-b'] = '2';
          }
        ]
      }
    });
    assert.strictEqual(res.body, '1,2');
  } finally {
    server.close();
  }
});

test('hooks beforeRetry altera headers da nova tentativa', async () => {
  let n = 0;
  const { server, url } = await listen((req, res) => {
    n++;
    if (n === 1) {
      res.statusCode = 503;
      return res.end('x');
    }
    res.end(req.headers['x-token']);
  });
  try {
    const res = await request.get(url, {
      retries: 1,
      retryDelay: 1,
      hooks: {
        beforeRequest: (req) => { req.headers['x-token'] = 'first'; },
        beforeRetry: ({ headers, attempt, response }) => {
          assert.strictEqual(response.statusCode, 503);
          headers['x-token'] = 'retry-' + attempt;
        }
      }
    });
    assert.strictEqual(res.body, 'retry-1');
  } finally {
    server.close();
  }
});

test('hooks afterResponse pode alterar res.body', async () => {
  const { server, url } = await listen((req, res) => res.end('abc'));
  try {
    const hooks = { afterResponse: (res) => { res.body = res.body.toUpperCase(); } };
    const res = await request.get(url, { hooks });
    assert.strictEqual(res.body, 'ABC');
    await new Promise((resolve) => {
      request(url, { hooks }, (err, r, body) => {
        assert.ifError(err);
        assert.strictEqual(body, 'ABC');
        resolve();
      });
    });
  } finally {
    server.close();
  }
});

test('hooks em defaults se somam na ordem', async () => {
  const { server, url } = await listen((req, res) => res.end(req.headers['x-order']));
  try {
    const api = request.defaults({ hooks: { beforeRequest: (r) => { r.headers['x-order'] = '1'; } } });
    const res = await api.get(url, { hooks: { beforeRequest: (r) => { r.headers['x-order'] += '2'; } } });
    assert.strictEqual(res.body, '12');
  } finally {
    server.close();
  }
});

test('erro dentro de hook rejeita a requisicao', async () => {
  let hits = 0;
  const { server, url } = await listen((req, res) => { hits++; res.end('x'); });
  try {
    await assert.rejects(
      request.get(url, { hooks: { beforeRequest: () => { throw new Error('falhou no hook'); } } }),
      /falhou no hook/
    );
    assert.strictEqual(hits, 0);
    await assert.rejects(
      request.get(url, { hooks: { afterResponse: async () => { throw new Error('falhou depois'); } } }),
      /falhou depois/
    );
  } finally {
    server.close();
  }
});

test('onUploadProgress com Buffer', async () => {
  const { server, url } = await listen((req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => res.end(String(n)));
  });
  try {
    const events = [];
    const res = await request.post(url, {
      body: Buffer.alloc(300000, 1),
      onUploadProgress: (p) => events.push(p)
    });
    assert.strictEqual(res.body, '300000');
    assert.ok(events.length > 1);
    const last = events[events.length - 1];
    assert.strictEqual(last.transferred, 300000);
    assert.strictEqual(last.total, 300000);
    for (let i = 1; i < events.length; i++) assert.ok(events[i].transferred >= events[i - 1].transferred);
  } finally {
    server.close();
  }
});

test('onUploadProgress com stream', async () => {
  const { Readable } = require('stream');
  const { server, url } = await listen((req, res) => {
    let n = 0;
    req.on('data', (c) => { n += c.length; });
    req.on('end', () => res.end(String(n)));
  });
  try {
    const events = [];
    const res = await request.post(url, {
      body: Readable.from([Buffer.alloc(1000), Buffer.alloc(2000)]),
      onUploadProgress: (p) => events.push(p)
    });
    assert.strictEqual(res.body, '3000');
    assert.strictEqual(events[events.length - 1].transferred, 3000);
    assert.strictEqual(events[events.length - 1].total, undefined);
  } finally {
    server.close();
  }
});

test('onDownloadProgress informa transferred e total', async () => {
  const { server, url } = await listen((req, res) => {
    res.setHeader('content-length', 200000);
    res.end(Buffer.alloc(200000, 1));
  });
  try {
    const events = [];
    const res = await request.get(url, { encoding: null, onDownloadProgress: (p) => events.push(p) });
    assert.strictEqual(res.body.length, 200000);
    const last = events[events.length - 1];
    assert.strictEqual(last.transferred, 200000);
    assert.strictEqual(last.total, 200000);
  } finally {
    server.close();
  }
});

test('erro dentro do callback de progresso rejeita', async () => {
  const { server, url } = await listen((req, res) => res.end('conteudo'));
  try {
    await assert.rejects(
      request.get(url, { onDownloadProgress: () => { throw new Error('falhou no progresso'); } }),
      /falhou no progresso/
    );
  } finally {
    server.close();
  }
});

test('Jar toJSON e fromJSON restauram a sessao', async () => {
  const { server, url } = await listen((req, res) => {
    if (req.url === '/login') res.setHeader('set-cookie', ['sid=abc; Path=/']);
    res.end(String(req.headers.cookie || ''));
  });
  try {
    const jar = request.jar();
    await request.get(url + '/login', { jar });

    const fromObject = request.Jar.fromJSON(JSON.parse(JSON.stringify(jar)));
    assert.strictEqual((await request.get(url + '/me', { jar: fromObject })).body, 'sid=abc');

    const fromString = request.Jar.fromJSON(JSON.stringify(jar));
    assert.strictEqual((await request.get(url + '/me', { jar: fromString })).body, 'sid=abc');
  } finally {
    server.close();
  }
});

test('Jar.fromJSON valida os dados', () => {
  assert.throws(() => request.Jar.fromJSON('{}'), TypeError);
  assert.throws(() => request.Jar.fromJSON(null), TypeError);
  const jar = request.Jar.fromJSON({ cookies: [{ name: 1 }, null, { name: 'a', value: '1', domain: '127.0.0.1' }] });
  assert.strictEqual(jar.getCookieString('http://127.0.0.1/'), 'a=1');
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
