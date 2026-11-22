# reqly-http

[![npm](https://img.shields.io/npm/v/reqly-http)](https://www.npmjs.com/package/reqly-http)
[![CI](https://github.com/flashytbrdev/reqly-http/actions/workflows/ci.yml/badge.svg)](https://github.com/flashytbrdev/reqly-http/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/reqly-http)](LICENSE)
[![node](https://img.shields.io/node/v/reqly-http)](package.json)

🇧🇷 [Versão em português](https://github.com/flashytbrdev/reqly-http/blob/main/README.md)

**Zero-dependency** HTTP/HTTPS client with the API of the old [`request`](https://www.npmjs.com/package/request) (callback + stream) and native **Promise/async-await**. Includes TypeScript types, proxy, cookies, multipart and retry.

```bash
npm install reqly-http
```

## Usage

```js
// CommonJS
const request = require('reqly-http');

// ESM
import request, { get, post, jar } from 'reqly-http';
```

```js
// callback (same as the original request)
request('https://api.example.com/users', { json: true }, (err, res, body) => {
  if (err) return console.error(err);
  console.log(res.statusCode, body);
});

// async/await (resolves with the response; body in res.body)
const res = await request.get('https://api.example.com/users', { json: true });

// POST JSON / form / multipart
await request.post(url, { json: { name: 'reqly' } });
await request.post(url, { form: { a: 1, b: 2 } });
await request.post(url, {
  formData: {
    field: 'text',
    file: fs.createReadStream('photo.png'),
    other: { value: Buffer.from('abc'), options: { filename: 'a.txt', contentType: 'text/plain' } }
  }
});

// stream download / upload (without loading everything in memory)
request('https://example.com/big.zip').pipe(fs.createWriteStream('big.zip'));
await request.put(url, { body: fs.createReadStream('big.zip') });

// cookies
const jar = request.jar();
await request.get(loginUrl, { jar });
await request.get(privateUrl, { jar });   // cookies are sent automatically

// retry with backoff (honors Retry-After)
await request.get(url, { retries: 3, retryDelay: 200 });

// proxy
await request.get(url, { proxy: 'http://user:password@127.0.0.1:8080' });

// cancel with AbortSignal
const ac = new AbortController();
const p = request.get(url, { signal: ac.signal });
ac.abort();
await p.catch((e) => e.code);   // 'ABORTED'

// reject on 4xx/5xx
try {
  await request.get(url, { throwHttpErrors: true });
} catch (e) {
  console.log(e.code, e.statusCode, e.body);   // 'EHTTP', 404, ...
}

// timeouts per phase (a number means inactivity)
await request.get(url, { timeout: { connect: 3000, response: 5000, total: 20000 } });

// hooks (function or array, sync or async)
const authed = request.defaults({
  hooks: {
    beforeRequest: [(req) => { req.headers.authorization = 'Bearer ' + token; }],
    beforeRetry: [async ({ headers }) => { headers.authorization = 'Bearer ' + await refreshToken(); }],
    afterResponse: [(res) => console.log(res.statusCode, res.request.uri.href)]
  }
});

// upload and download progress
await request.put(url, {
  body: fs.createReadStream('big.zip'),
  onUploadProgress: ({ transferred, total }) => console.log(transferred, total)
});
await request.get(url, { onDownloadProgress: ({ transferred, total }) => console.log(transferred, total) });

// conditional cache (ETag / Last-Modified)
const cache = new Map();
await request.get(url, { cache });   // 200, stores the body
await request.get(url, { cache });   // server answers 304 -> res.fromCache === true, body comes from the cache

// at most 3 requests at a time per host
await Promise.all(urls.map((u) => request.get(u, { maxConcurrent: 3 })));

// Unix socket (Docker)
await request.get('http://localhost/containers/json', { socketPath: '/var/run/docker.sock', json: true });

// save and restore cookies
fs.writeFileSync('cookies.json', JSON.stringify(jar));
const restored = request.Jar.fromJSON(fs.readFileSync('cookies.json', 'utf8'));

// defaults
const api = request.defaults({ baseUrl: 'https://api.example.com', json: true, headers: { 'user-agent': 'my-app' } });
const { body } = await api.get('/users', { qs: { page: 2 } });
```

## Options

| Option | Description |
|---|---|
| `uri` / `url`, `baseUrl`, `method`, `headers`, `qs` | Basics. Arrays in `qs` repeat the key |
| `body` | `string`, `Buffer` or **stream** (chunked upload) |
| `json` | `true`: sends `body` as JSON and parses the response. Object: used as the body |
| `jsonReviver` / `jsonReplacer` | Passed to `JSON.parse` / `JSON.stringify` |
| `form` | `application/x-www-form-urlencoded` |
| `formData` | `multipart/form-data` (string, number, Buffer, stream, `{ value, options }`, arrays). Streams are sent without being loaded into memory; `Content-Length` is computed for `fs.createReadStream` or with `options.knownLength`, otherwise the upload is chunked |
| `auth` | `{ user, pass }` (Basic) or `{ bearer }`; also accepts `user:pass@` in the URL |
| `jar` | `true` (global jar) or `request.jar()` |
| `timeout` | Number: inactivity in ms. Object: `{ connect, response, total, idle }` in ms. Error `ETIMEDOUT` with `err.phase` (`'connect'`, `'response'`, `'total'` or `'idle'`). Connect, response and idle timeouts go through retry |
| `signal` | `AbortSignal` to cancel the request (error `ABORTED`) |
| `throwHttpErrors` | `true`: status >= 400 rejects with an `EHTTP` error (`statusCode`, `response`, `body`). Default `false` |
| `hooks` | `{ beforeRequest, beforeRetry, afterResponse }`: function or array, sync or async. `beforeRequest(req)` and `beforeRetry({ request, attempt, error, response, headers })` can change headers; `afterResponse(res, req)` runs with the body read and can change `res.body`. With `defaults`, hooks are added together |
| `onUploadProgress` / `onDownloadProgress` | `({ transferred, total })` on every chunk; `total` can be `undefined` (for downloads it only exists without compression) |
| `cache` | `true` (global cache, up to 100 URLs) or an object with `get(key)`/`set(key, value)` (a `Map` works). GET only: sends `If-None-Match`/`If-Modified-Since` and, on `304`, returns the stored body with `statusCode` 200 and `res.fromCache === true`. Does not store `no-store`, `Set-Cookie` or `buffer: false` |
| `maxConcurrent` | Maximum simultaneous requests per host; the others wait in a queue (waiting counts toward `timeout.total`) |
| `socketPath` | Path of a Unix socket; the URL only sets the `Host` and the path |
| `gzip` | Default `true`: decompresses gzip/deflate/br |
| `encoding` | Default: response charset or `utf8`; `null` returns a `Buffer`. Accepts any `TextDecoder` charset (`windows-1252`, `shift_jis`...) |
| `buffer` | `false`: does not keep the body (use `data`/`pipe`) |
| `maxResponseSize` | Bytes; when exceeded, error `ERESPONSETOOLARGE` |
| `followRedirect`, `followAllRedirects`, `maxRedirects` | Redirects (default: GET/HEAD, up to 10) |
| `retries`, `retryDelay`, `retryOn`, `retryNonIdempotent` | Retry on 408/429/500/502/503/504 and network errors (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `EPIPE`). Only GET/HEAD/PUT/DELETE/OPTIONS, unless `retryNonIdempotent` |
| `proxy`, `noProxy` | HTTP and HTTPS (CONNECT tunnel) with auth. Without `proxy`, uses `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` from the environment (ignores localhost). `proxy: false` disables it |
| `forever` / `keepAlive` | Reuses connections (shared keep-alive agent) |
| `strictSSL`, `ca`, `cert`, `key`, `pfx`, `passphrase`... | TLS |
| `agent`, `family`, `localAddress`, `lookup` | Passed through to `http`/`https` |

Methods: `request.get/post/put/patch/head/options/delete` (`del`), `request.defaults(opts)`, `request.jar()`, `jar.toJSON()` and `request.Jar.fromJSON(data)`.

The returned object emits `request`, `response`, `data`, `end`, `complete`, `redirect`, `retry`, `abort`, `error` and has `.pipe()`, `.abort()` (error `ABORTED`) and `.then()/.catch()/.finally()`.

## TypeScript

```ts
import request from 'reqly-http';

interface User { id: number; name: string }

const { body } = await request.get<User[]>('https://api.example.com/users', { json: true });
body[0].name;
```

## Differences from the original `request`

- No dependencies; Node >= 14 (tested on 14, 16, 18, 20 and 22). CommonJS and ESM.
- `gzip` is on by default.
- `await request(...)` resolves with the `response` (body in `res.body`), even on 4xx/5xx; use `throwHttpErrors` to reject.
- Not included: HTTP/2, `oauth`, `aws`, `hawk`, `httpSignature` and `request.write()` (to send a body as a stream use the `body` option).

## License

MIT
