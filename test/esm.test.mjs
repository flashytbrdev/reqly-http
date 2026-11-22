import http from 'http';
import assert from 'assert';
import { createRequire } from 'module';
import request, { get, post, put, del, delete as del2, defaults, jar, Jar, Request } from '../index.mjs';
import selfRef from 'reqly-http';

const require = createRequire(import.meta.url);
const cjs = require('../index.js');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }));
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port;
const tests = [];
const test = (n, f) => tests.push([n, f]);

test('default export é a mesma instância do CommonJS', () => {
  assert.strictEqual(request, cjs);
  assert.strictEqual(selfRef, request);
  assert.strictEqual(require('reqly-http'), cjs);
});
test('exports nomeados', () => {
  assert.strictEqual(get, cjs.get);
  assert.strictEqual(post, cjs.post);
  assert.strictEqual(put, cjs.put);
  assert.strictEqual(del, cjs.del);
  assert.strictEqual(del2, cjs.delete);
  assert.strictEqual(Jar, cjs.Jar);
  assert.strictEqual(Request, cjs.Request);
  assert.ok(jar() instanceof Jar);
});
test('import + await', async () => {
  const res = await get(base + '/x', { json: true });
  assert.strictEqual(res.body.method, 'GET');
});
test('post/put/delete nomeados', async () => {
  assert.strictEqual((await post(base, { json: { a: 1 } })).body.body, '{"a":1}');
  assert.strictEqual((await put(base, { json: { b: 2 } })).body.method, 'PUT');
  assert.strictEqual((await del2(base, { json: true })).body.method, 'DELETE');
});
test('defaults', async () => {
  const api = defaults({ baseUrl: base, json: true });
  assert.strictEqual((await api.get('/z')).body.method, 'GET');
});
test('import() dinâmico a partir do CommonJS', async () => {
  const m = await import('reqly-http');
  assert.strictEqual(m.default, request);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { await fn(); console.log('  ✓ [esm]', name); }
  catch (e) { failed++; console.log('  ✗ [esm]', name, '\n    ', e && e.message); }
}
server.close();
console.log(failed ? `\n${failed} falhou(ram) (ESM)` : `\n${tests.length} testes ESM ok`);
process.exit(failed ? 1 : 0);
