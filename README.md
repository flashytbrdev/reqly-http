# reqly-http

[![npm](https://img.shields.io/npm/v/reqly-http)](https://www.npmjs.com/package/reqly-http)
[![CI](https://github.com/flashytbrdev/reqly-http/actions/workflows/ci.yml/badge.svg)](https://github.com/flashytbrdev/reqly-http/actions/workflows/ci.yml)
[![licença](https://img.shields.io/npm/l/reqly-http)](LICENSE)
[![node](https://img.shields.io/node/v/reqly-http)](package.json)

🇺🇸 [English version](https://github.com/flashytbrdev/reqly-http/blob/main/README.en.md)

Cliente HTTP/HTTPS **sem dependências**, com a API da antiga [`request`](https://www.npmjs.com/package/request) (callback + stream) e **Promise/async-await** nativo. Inclui tipagem TypeScript, proxy, cookies, multipart e retry.

```bash
npm install reqly-http
```

## Uso

```js
// CommonJS
const request = require('reqly-http');

// ESM
import request, { get, post, jar } from 'reqly-http';
```

```js
// callback (igual ao request original)
request('https://api.exemplo.com/users', { json: true }, (err, res, body) => {
  if (err) return console.error(err);
  console.log(res.statusCode, body);
});

// async/await (resolve com a response; corpo em res.body)
const res = await request.get('https://api.exemplo.com/users', { json: true });

// POST JSON / form / multipart
await request.post(url, { json: { nome: 'reqly' } });
await request.post(url, { form: { a: 1, b: 2 } });
await request.post(url, {
  formData: {
    campo: 'texto',
    arquivo: fs.createReadStream('foto.png'),
    outro: { value: Buffer.from('abc'), options: { filename: 'a.txt', contentType: 'text/plain' } }
  }
});

// download / upload em stream (sem carregar tudo na memória)
request('https://exemplo.com/grande.zip').pipe(fs.createWriteStream('grande.zip'));
await request.put(url, { body: fs.createReadStream('grande.zip') });

// cookies
const jar = request.jar();
await request.get(urlLogin, { jar });
await request.get(urlPrivada, { jar });   // envia os cookies automaticamente

// retry com backoff (respeita Retry-After)
await request.get(url, { retries: 3, retryDelay: 200 });

// proxy
await request.get(url, { proxy: 'http://user:senha@127.0.0.1:8080' });

// cancelar com AbortSignal
const ac = new AbortController();
const p = request.get(url, { signal: ac.signal });
ac.abort();
await p.catch((e) => e.code);   // 'ABORTED'

// rejeitar em 4xx/5xx
try {
  await request.get(url, { throwHttpErrors: true });
} catch (e) {
  console.log(e.code, e.statusCode, e.body);   // 'EHTTP', 404, ...
}

// timeouts por fase (número = inatividade)
await request.get(url, { timeout: { connect: 3000, response: 5000, total: 20000 } });

// hooks (função ou array, sync ou async)
const autenticado = request.defaults({
  hooks: {
    beforeRequest: [(req) => { req.headers.authorization = 'Bearer ' + token; }],
    beforeRetry: [async ({ headers }) => { headers.authorization = 'Bearer ' + await renovarToken(); }],
    afterResponse: [(res) => console.log(res.statusCode, res.request.uri.href)]
  }
});

// progresso de upload e download
await request.put(url, {
  body: fs.createReadStream('grande.zip'),
  onUploadProgress: ({ transferred, total }) => console.log(transferred, total)
});
await request.get(url, { onDownloadProgress: ({ transferred, total }) => console.log(transferred, total) });

// cache condicional (ETag / Last-Modified)
const cache = new Map();
await request.get(url, { cache });   // 200, guarda o corpo
await request.get(url, { cache });   // 304 do servidor -> res.fromCache === true, corpo vem do cache

// no máximo 3 requisições ao mesmo tempo por host
await Promise.all(urls.map((u) => request.get(u, { maxConcurrent: 3 })));

// socket Unix (Docker)
await request.get('http://localhost/containers/json', { socketPath: '/var/run/docker.sock', json: true });

// salvar e restaurar cookies
fs.writeFileSync('cookies.json', JSON.stringify(jar));
const restaurado = request.Jar.fromJSON(fs.readFileSync('cookies.json', 'utf8'));

// defaults
const api = request.defaults({ baseUrl: 'https://api.exemplo.com', json: true, headers: { 'user-agent': 'meu-app' } });
const { body } = await api.get('/users', { qs: { page: 2 } });
```

## Opções

| Opção | Descrição |
|---|---|
| `uri` / `url`, `baseUrl`, `method`, `headers`, `qs` | Básico. Arrays em `qs` repetem a chave |
| `body` | `string`, `Buffer` ou **stream** (upload chunked) |
| `json` | `true`: envia `body` como JSON e faz parse da resposta. Objeto: usado como body |
| `jsonReviver` / `jsonReplacer` | Passados ao `JSON.parse` / `JSON.stringify` |
| `form` | `application/x-www-form-urlencoded` |
| `formData` | `multipart/form-data` (string, número, Buffer, stream, `{ value, options }`, arrays). Streams são enviados sem ir inteiros para a memória; o `Content-Length` é calculado para `fs.createReadStream` ou com `options.knownLength`, senão o envio é chunked |
| `auth` | `{ user, pass }` (Basic) ou `{ bearer }`; também aceita `user:pass@` na URL |
| `jar` | `true` (jar global) ou `request.jar()` |
| `timeout` | Número: ms de inatividade. Objeto: `{ connect, response, total, idle }` em ms. Erro `ETIMEDOUT` com `err.phase` (`'connect'`, `'response'`, `'total'` ou `'idle'`). Timeouts de conexão, resposta e inatividade entram no retry |
| `hooks` | `{ beforeRequest, beforeRetry, afterResponse }`: função ou array, sync ou async. `beforeRequest(req)` e `beforeRetry({ request, attempt, error, response, headers })` podem alterar os headers; `afterResponse(res, req)` roda com o corpo lido e pode alterar `res.body`. Em `defaults`, os hooks se somam |
| `onUploadProgress` / `onDownloadProgress` | `({ transferred, total })` a cada bloco; `total` pode ser `undefined` (no download só existe sem compressão) |
| `cache` | `true` (cache global, até 100 URLs) ou objeto com `get(chave)`/`set(chave, valor)` (um `Map` serve). Só GET: envia `If-None-Match`/`If-Modified-Since` e, em `304`, devolve o corpo guardado com `statusCode` 200 e `res.fromCache === true`. Não guarda `no-store`, `Set-Cookie` nem `buffer: false` |
| `maxConcurrent` | Máximo de requisições simultâneas por host; as outras esperam na fila (a espera conta no `timeout.total`) |
| `socketPath` | Caminho de um socket Unix; a URL só define o `Host` e o caminho |
| `gzip` | Padrão `true`: descomprime gzip/deflate/br |
| `encoding` | Padrão: charset da resposta ou `utf8`; `null` retorna `Buffer`. Aceita qualquer charset do `TextDecoder` (`windows-1252`, `shift_jis`...) |
| `buffer` | `false`: não guarda o corpo (use `data`/`pipe`) |
| `maxResponseSize` | Bytes; excedendo, erro `ERESPONSETOOLARGE` |
| `followRedirect`, `followAllRedirects`, `maxRedirects` | Redirects (padrão: GET/HEAD, até 10) |
| `retries`, `retryDelay`, `retryOn`, `retryNonIdempotent` | Retry em 408/429/500/502/503/504 e erros de rede (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `EPIPE`). Só GET/HEAD/PUT/DELETE/OPTIONS, salvo `retryNonIdempotent` |
| `proxy`, `noProxy` | HTTP e HTTPS (túnel CONNECT) com auth. Sem `proxy`, usa `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` do ambiente (ignora localhost). `proxy: false` desativa |
| `signal` | `AbortSignal` para cancelar a requisição (erro `ABORTED`) |
| `throwHttpErrors` | `true`: status >= 400 rejeita com erro `EHTTP` (`statusCode`, `response`, `body`). Padrão `false` |
| `forever` / `keepAlive` | Reutiliza conexões (agent keep-alive compartilhado) |
| `strictSSL`, `ca`, `cert`, `key`, `pfx`, `passphrase`... | TLS |
| `agent`, `family`, `localAddress`, `lookup` | Repassados ao `http`/`https` |

Métodos: `request.get/post/put/patch/head/options/delete` (`del`), `request.defaults(opts)`, `request.jar()`, `jar.toJSON()` e `request.Jar.fromJSON(dados)`.

O objeto retornado emite `request`, `response`, `data`, `end`, `complete`, `redirect`, `retry`, `abort`, `error` e tem `.pipe()`, `.abort()` (erro `ABORTED`) e `.then()/.catch()/.finally()`.

## TypeScript

```ts
import request from 'reqly-http';

interface User { id: number; name: string }

const { body } = await request.get<User[]>('https://api.exemplo.com/users', { json: true });
body[0].name;
```

## Diferenças da `request` original

- Sem dependências; Node >= 14 (testado em 14, 16, 18, 20 e 22). CommonJS e ESM.
- `gzip` ligado por padrão.
- `await request(...)` resolve com a `response` (corpo em `res.body`), mesmo em 4xx/5xx; use `throwHttpErrors` para rejeitar.
- Não incluídos: HTTP/2, `oauth`, `aws`, `hawk`, `httpSignature` e `request.write()` (para enviar corpo por stream use a opção `body`).

## Licença

MIT
