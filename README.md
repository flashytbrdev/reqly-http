# reqly-http

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
await request.post(url, { json: { nome: 'Zypher' } });
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
| `formData` | `multipart/form-data` (string, número, Buffer, stream, `{ value, options }`, arrays) |
| `auth` | `{ user, pass }` (Basic) ou `{ bearer }`; também aceita `user:pass@` na URL |
| `jar` | `true` (jar global) ou `request.jar()` |
| `timeout` | ms de inatividade, erro `ETIMEDOUT` |
| `gzip` | Padrão `true`: descomprime gzip/deflate/br |
| `encoding` | Padrão: charset da resposta ou `utf8`; `null` retorna `Buffer` |
| `buffer` | `false`: não guarda o corpo (use `data`/`pipe`) |
| `maxResponseSize` | Bytes; excedendo, erro `ERESPONSETOOLARGE` |
| `followRedirect`, `followAllRedirects`, `maxRedirects` | Redirects (padrão: GET/HEAD, até 10) |
| `retries`, `retryDelay`, `retryOn`, `retryNonIdempotent` | Retry em 408/429/500/502/503/504 e erros de rede (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EAI_AGAIN`, `EPIPE`). Só GET/HEAD/PUT/DELETE/OPTIONS, salvo `retryNonIdempotent` |
| `proxy`, `noProxy` | HTTP e HTTPS (túnel CONNECT) com auth. Sem `proxy`, usa `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` do ambiente (ignora localhost). `proxy: false` desativa |
| `forever` / `keepAlive` | Reutiliza conexões (agent keep-alive compartilhado) |
| `strictSSL`, `ca`, `cert`, `key`, `pfx`, `passphrase`... | TLS |
| `agent`, `family`, `localAddress`, `lookup` | Repassados ao `http`/`https` |

Métodos: `request.get/post/put/patch/head/options/delete` (`del`), `request.defaults(opts)`, `request.jar()`.

O objeto retornado emite `request`, `response`, `data`, `end`, `complete`, `redirect`, `retry`, `abort`, `error` e tem `.pipe()`, `.abort()` (erro `ABORTED`) e `.then()/.catch()/.finally()`.

## Diferenças da `request` original

- Sem dependências; Node >= 14 (testado em 14, 16, 18, 20 e 22). CommonJS e ESM.
- `gzip` ligado por padrão.
- `await request(...)` resolve com a `response` (corpo em `res.body`).
- Não incluídos: `oauth`, `aws`, `hawk`, `httpSignature` e `request.write()` (para enviar corpo por stream use a opção `body`).

## Licença

MIT
