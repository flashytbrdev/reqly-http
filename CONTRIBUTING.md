# Contribuindo

## Testes

```bash
npm test            # testes CommonJS + ESM com servidores locais
npm run test:real   # APIs reais (precisa de internet): npm registry, GitHub e httpbin
```

`test:real` pula grupos inacessíveis (sem rede ou com rate limit). Para usar seu próprio httpbin:

```bash
HTTPBIN_URL=http://localhost:8080 npm run test:real
```

Os testes locais cobrem HTTP, HTTPS com certificado de teste, proxy HTTP/CONNECT, gzip/deflate/br, download de 20MB, upload de 10MB, retry, cookies, multipart, IPv6, keep-alive e 100 requisições concorrentes.

## CI

O workflow `.github/workflows/ci.yml` roda os testes em Node 14 a 22 (e Windows/macOS), verifica as tipagens e o conteúdo do pacote. Toda segunda-feira roda também os testes contra APIs reais.

## Pull requests

- Rode `npm test` antes de abrir o PR.
- Adicione um teste para cada comportamento novo ou bug corrigido.
- Atualize o `CHANGELOG.md`.
