# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento [SemVer](https://semver.org/lang/pt-BR/).

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
