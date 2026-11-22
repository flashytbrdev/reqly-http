# Contribuindo

## Testes

```bash
npm test            # testes CommonJS, ESM e novidades (v13, v14) com servidores locais
npm run test:real   # APIs reais (precisa de internet): npm registry, GitHub e httpbin
```

`test:real` pula grupos inacessíveis (sem rede ou com rate limit). Para usar seu próprio httpbin:

```bash
HTTPBIN_URL=http://localhost:8080 npm run test:real
```

Os testes locais cobrem HTTP, HTTPS com certificado de teste, proxy HTTP/CONNECT, gzip/deflate/br, download de 20MB, upload de 10MB, retry, cookies, multipart, IPv6, keep-alive e 100 requisições concorrentes.

## CI

O workflow `.github/workflows/ci.yml` roda os testes em Node 14 a 22 (e Windows/macOS), verifica as tipagens e o conteúdo do pacote. Toda segunda-feira roda também os testes contra APIs reais.

## Publicação

O workflow `.github/workflows/release.yml` publica no npm (com `--provenance`) quando uma tag `v*` é enviada. Ele confere se a tag bate com a versão do `package.json`, roda `npm test` e pula a publicação se essa versão já existe no npm.

```bash
npm version patch   # ou minor / major: atualiza o package.json, cria o commit e a tag
git push --follow-tags
```

É preciso criar o secret `NPM_TOKEN` (token de automação do npm) em Settings → Secrets and variables → Actions do repositório.

## Pull requests

- Rode `npm test` antes de abrir o PR.
- Adicione um teste para cada comportamento novo ou bug corrigido.
- Atualize o `CHANGELOG.md`.
