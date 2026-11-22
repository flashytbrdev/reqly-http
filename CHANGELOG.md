# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

## [1.3.0] - 2026-11-22

### Adicionado
- Opção `signal` (`AbortSignal`) para cancelar requisições; o erro tem `code: 'ABORTED'`, igual ao `abort()`.
- Opção `throwHttpErrors`: com `true`, respostas 4xx/5xx rejeitam com erro `EHTTP` (`statusCode`, `response`, `body`). O padrão continua `false`.
- **Timeouts por fase**: `timeout: { connect, response, total, idle }`; o erro `ETIMEDOUT` ganha `phase`. Número continua valendo como timeout de inatividade.
- **Hooks**: `hooks.beforeRequest`, `hooks.beforeRetry` e `hooks.afterResponse` (sync ou async); em `defaults` eles se somam.
- **Progresso**: `onUploadProgress` e `onDownloadProgress`.
- **Cookie jar persistente**: `jar.toJSON()` e `Jar.fromJSON()` (aceita objeto ou string JSON).
- **Tipos genéricos**: `request.get<User[]>(...)` com `res.body` tipado. Também `TimeoutOptions`, `Hooks`, `Progress` e `JarData`.
- Tipo `HTTPError` e testes para as novidades (`test/v13.test.js`).
- README em inglês (`README.en.md`), badges e workflow de release (`.github/workflows/release.yml`, publica com `--provenance`).
- O evento `retry` agora também recebe o erro como terceiro argumento.
- Campos `repository`, `homepage`, `bugs` e `author` no `package.json`.
- **Cache condicional**: `cache: true` (cache global em memória, até 100 URLs) ou um objeto com `get`/`set` (um `Map` serve). Envia `If-None-Match`/`If-Modified-Since` e, em `304`, devolve o corpo guardado com `statusCode` 200 e `res.fromCache = true`. Só GET, e não guarda respostas com `no-store` ou `Set-Cookie`.
- **`maxConcurrent`**: limite de requisições simultâneas por host; as demais esperam na fila.
- **`socketPath`**: requisições por socket Unix (Docker, por exemplo).
- **Charsets**: qualquer charset conhecido pelo `TextDecoder` (windows-1252, shift_jis, windows-1251...), tanto no `Content-Type` quanto em `encoding`. Charset desconhecido cai para utf8.
- **Multipart em stream**: arquivos do `formData` não são mais lidos inteiros para a memória. Com `fs.createReadStream` (arquivo inteiro) ou `options.knownLength` o `Content-Length` é calculado; sem tamanho conhecido, o envio é chunked.
- Testes novos em `test/v13.test.js` e `test/v14.test.js`.

### Alterado
- Titular da licença atualizado para flashytbr.
- Prefixo do boundary do multipart agora é `ReqlyBoundary`.
- Um `formData` com stream agora não pode ser reenviado em retry nem em redirect 307/308, como qualquer outro corpo em stream. Só texto e Buffer continuam reenviáveis.

### Corrigido
- `Retry-After` agora também aceita data HTTP, não só segundos.
- Redirect para outro host não reenvia mais o header `cookie` definido manualmente.

## [1.2.3] - 2026-11-21

### Alterado
- Comentários removidos do código-fonte e dos testes (sem mudança de comportamento).

## [1.2.2] - 2026-11-21

### Alterado
- Republicação para atualizar a página do pacote no npm (sem mudanças de código).

## [1.2.1] - 2026-11-21

### Alterado
- README enxuto: instruções de testes, CI e publicação movidas para o `CONTRIBUTING.md` (que não vai no pacote npm).

## [1.2.0] - 2026-11-21

### Adicionado
- Suporte a **ESM**: `import request, { get, post } from 'reqly-http'` (mapa `exports` no `package.json`, `index.mjs`).
- Tipagens separadas para ESM (`index.d.mts`) e CommonJS (`index.d.ts`), com tipos exportados (`Options`, `Response`, `Jar`...).
- **CI no GitHub Actions**: testes em Node 14 a 22, Windows e macOS, verificação de tipos e conteúdo do pacote.
- **Testes contra APIs reais** (`npm run test:real`): npm registry, GitHub e httpbin. Semanalmente no CI.
- `CHANGELOG.md` e `.gitignore`.

### Alterado
- Projeto renomeado de `hyperion-request` para **`reqly-http`**.
- `npm test` agora também executa os testes ESM.

## [1.1.0] - 2026-11-21

### Adicionado
- **Proxy** HTTP e HTTPS (túnel `CONNECT`) com autenticação, além de `HTTP_PROXY`, `HTTPS_PROXY` e `NO_PROXY`.
- **Cookie jar** (`request.jar()`), inclusive através de redirects.
- **Multipart** (`formData`) com texto, Buffer e streams.
- **Retry** com backoff exponencial e suporte a `Retry-After`.
- Upload de `body` em stream (chunked), `buffer: false` e `maxResponseSize`.
- `forever`/`keepAlive`, `abort()` (erro `ABORTED`), `jsonReviver`/`jsonReplacer`, detecção de charset e remoção de BOM no JSON.
- Detecção de resposta cortada (`ECONNRESET`).

### Corrigido
- Descompressão de deflate e brotli validada com testes.

## [1.0.0] - 2026-11-21

### Adicionado
- Primeira versão: API compatível com a `request` (callback, stream, `defaults`), Promise nativa, JSON, form, `qs`, auth, redirects, timeout, gzip.
