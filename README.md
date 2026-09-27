# mcp-apis-time

Servidor MCP que expõe as specs OpenAPI do time para uma IA (Claude, Copilot, Cursor...) navegar pela documentação e **criar casos de teste** das APIs.

As specs ficam versionadas no próprio repositório, em `specs/`. Não há build: o servidor lê os JSON direto da pasta e recarrega automaticamente quando um arquivo muda.

## Estrutura

```
specs/                  ← coloque aqui os JSON OpenAPI (um arquivo por API)
src/
  config.js             ← pasta das specs, porta, limites
  specs.js              ← descoberta e cache dos arquivos
  openapi.js            ← resolução de $ref, allOf, parâmetros, respostas, segurança
  testing.js            ← payloads de exemplo e cenários de teste derivados da spec
  mcp.js                ← tools, prompts e resources do MCP
  web.js                ← rotas HTTP + autenticação por token
  app.js                ← entrypoint da Vercel
  http.js               ← servidor HTTP de longa duração (local, Docker, Render...)
  stdio.js              ← transporte stdio (Claude Desktop, VS Code, Cursor, Claude Code)
scripts/
  validate-specs.js     ← validação das specs
  build-bundle.js       ← empacota as specs para a Vercel
vercel.json · Dockerfile
test/                   ← testes com node:test
examples/               ← configs de cliente prontas
```

## Começando

```bash
npm install
npm run validate   # confere as specs
npm test
npm start          # HTTP em http://127.0.0.1:3001/mcp
```

Para inspecionar as ferramentas no navegador: `npm run inspector`.

## Adicionando uma API

1. Exporte o OpenAPI da API (JSON, OpenAPI 3.x) e salve como `specs/<id>.json`. O nome do arquivo vira o `apiId` (ex.: `specs/faturamento.json` → `faturamento`). Use só letras, números, `.`, `_` e `-`.
2. Rode `npm run validate`. Erros bloqueiam; avisos indicam o que melhorar na spec para gerar testes melhores.
3. Commit. O servidor em execução já enxerga a nova API, sem reiniciar.

Quanto mais rica a spec, melhores os testes: `required`, `enum`, `minLength`/`maxLength`, `minimum`/`maximum`, `pattern`, `format`, exemplos e respostas 4xx documentadas viram cenários automaticamente.

## Conectando na IA

**Claude Desktop** — edite `claude_desktop_config.json` (modelo em `examples/`) apontando para o caminho absoluto de `src/stdio.js`.

**VS Code (Copilot agent mode)** — copie `examples/vscode-mcp.json` para `.vscode/mcp.json` do repositório.

**Claude Code** — `claude mcp add apis-time -- node /caminho/para/mcp-apis-time/src/stdio.js`

**HTTP local** — rode `npm start` e aponte o cliente para `http://127.0.0.1:3001/mcp`.

**Servidor hospedado** — veja a seção abaixo. Com a URL pública:

| Cliente | Como conectar |
|---|---|
| claude.ai (conector personalizado) | URL `https://SEU-PROJETO.vercel.app/mcp?token=SEU_TOKEN` (o formulário só aceita URL) |
| Claude Code | `claude mcp add --transport http apis-time https://SEU-PROJETO.vercel.app/mcp --header "Authorization: Bearer SEU_TOKEN"` |
| Claude Desktop / VS Code / Cursor | `url` + `headers: { "Authorization": "Bearer SEU_TOKEN" }` (ver `examples/`) |

## Deploy

### Vercel

1. Suba o repositório no GitHub e importe em [vercel.com/new](https://vercel.com/new). O Express é detectado sozinho (`src/app.js`), e o `vercel.json` manda rodar `npm run build`, que valida e empacota as specs.
2. Em **Settings → Environment Variables**, crie `MCP_AUTH_TOKEN` com um valor longo e aleatório (ex.: `openssl rand -hex 32`) e faça redeploy.
3. Teste: `https://SEU-PROJETO.vercel.app/mcp/health`.

Cada push na `main` com spec nova gera deploy automático. Se o build falhar, é spec inválida — rode `npm run validate` local.

Use a URL de produção: as URLs de *preview* da Vercel ficam atrás do login da Vercel por padrão e a IA não consegue acessá-las.

### Qualquer host com Docker (Render, Railway, Fly.io, Azure, infra interna)

```bash
docker build -t mcp-apis-time .
docker run -p 3001:3001 -e MCP_AUTH_TOKEN=seu-token mcp-apis-time
```

Ou, sem Docker, comando de start `npm start` — a porta vem de `PORT`, que essas plataformas já definem.

### Segurança

As specs descrevem endpoints e campos internos, então em hospedagem o servidor **recusa requisições sem `MCP_AUTH_TOKEN` configurado** (responde 503). Para acesso aberto de propósito, defina `MCP_ALLOW_ANONYMOUS=1`.

O token aceito em `?token=` existe por causa do claude.ai; ele pode aparecer em logs de acesso, então prefira o header nos clientes que suportam e troque o token se ele vazar. Para restringir de verdade, a alternativa é hospedar só na rede interna (VPN), sabendo que aí o claude.ai não alcança o servidor.

Variáveis de ambiente: `MCP_AUTH_TOKEN`, `MCP_ALLOW_ANONYMOUS`, `SPECS_DIR`, `PORT`/`MCP_PORT` (3001), `MCP_HOST` (127.0.0.1 local, 0.0.0.0 quando `PORT` existe), `MCP_MAX_RESPONSE_CHARS` (16000).

## Ferramentas

Navegação (mesmas do servidor original do portal):

| Tool | Para quê |
|---|---|
| `list_apis` | APIs disponíveis |
| `get_api_overview` | descrição, servidores, tags, esquemas de segurança |
| `list_operations` | endpoints, com filtro por tag |
| `get_operation_docs` | descrição funcional, parâmetros, respostas |
| `get_operation_schema` | schemas resolvidos em um nível |
| `get_schema_definition` | navegar em schemas aninhados |
| `search_documentation` | busca em caminhos, descrições, parâmetros e schemas |

Testes:

| Tool | Para quê |
|---|---|
| `get_operation_test_context` | visão achatada: cada campo com caminho (`cliente.endereco.cep`, `itens[].sku`), obrigatoriedade e restrições; segurança; campos das respostas |
| `generate_example_payload` | payload válido (modo `completo` ou `minimo`) usando exemplos da spec ou gerando pelo schema; já conhece CPF, CNPJ, CEP e telefone |
| `suggest_test_scenarios` | checklist determinístico de cenários: positivos, segurança, recurso inexistente, validação, valores-limite, erros documentados, idempotência — com status esperado e **lacunas da spec** |

Prompts prontos (aparecem como comandos `/` em vários clientes):

- `casos_de_teste_operacao` — casos completos de um endpoint, no formato escolhido (gherkin, tabela, jest, postman, restassured) e com espaço para regras de negócio.
- `plano_de_testes_api` — plano priorizado cobrindo a API inteira.

Resources: `docs://index` (índice) e `openapi://{apiId}` (spec bruta).

## Como usar para criar testes

Exemplo de pedido para a IA:

> Use o prompt casos_de_teste_operacao para POST /pedidos da API exemplo-pedidos, formato gherkin. Regra de negócio: pedidos acima de R$ 10.000 exigem aprovação e retornam status PENDENTE_APROVACAO.

A IA vai buscar o contexto, gerar os payloads base, percorrer o checklist e escrever os casos, complementando com a regra informada e listando o que a spec deixa em aberto.

Os cenários de `suggest_test_scenarios` descrevem uma **alteração** sobre o payload base (`remover` campo, `definir` valor, `omitir-corpo`...). Valores `{"$gerar": "string", "tamanho": N}` representam strings longas sem inflar a resposta.

## Diferenças em relação ao servidor do portal

- Lê os JSON de `specs/` diretamente; não precisa de `portal.config.json` nem dos `.md` de `llms/`.
- Resolve `$ref` em parâmetros, requestBodies e responses (não só em schemas) e mescla `allOf`.
- Parâmetros declarados no path-item são herdados pelas operações.
- Respostas grandes são compactadas antes de truncar, para continuarem JSON válido.
- Transporte stdio além do HTTP, deploy na Vercel e autenticação por token.

## Limitações

- Somente JSON e `$ref` locais (`#/...`). Refs para outros arquivos aparecem como aviso no `validate`.
- Swagger 2.0 funciona parcialmente; converta com `npx swagger2openapi entrada.json -o specs/saida.json`.
- Em `oneOf`/`anyOf` o gerador usa a primeira variante e avisa.
- Os cenários vêm só da spec: regras de negócio precisam ser informadas à IA.
